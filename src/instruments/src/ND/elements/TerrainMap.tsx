import React, { useEffect, useState, useRef } from 'react';
import { useArinc429Var } from '@instruments/common/arinc429';
import { useSimVar } from '@instruments/common/simVars';
import { Mode, EfisSide, rangeSettings } from '@shared/NavigationDisplay';
import { useUpdate } from '@instruments/common/hooks';

const RerenderingTimeout = 2500;

export interface TerrainMapProviderProps {
    side: EfisSide,
}

export const TerrainMapProvider: React.FC<TerrainMapProviderProps> = ({ side }) => {
    const arincLat = useArinc429Var('L:A32NX_ADIRS_IR_1_LATITUDE', 1000);
    const arincLong = useArinc429Var('L:A32NX_ADIRS_IR_1_LONGITUDE', 1000);
    const [verticalSpeed] = useSimVar('VERTICAL SPEED', 'feet per second', 1000);
    const [trueHeading] = useSimVar('PLANE HEADING DEGREES TRUE', 'degrees', 1000);
    const [altitude] = useSimVar('PLANE ALTITUDE', 'feet', 1000);
    const [updateTime, setUpdateTime] = useState<number>(0);

    useEffect(() => {
        const currentTime = new Date().getTime();

        // do not more than every 500 ms (unneeded due to system design)
        if (side === 'L' && arincLat.isNormalOperation() && arincLong.isNormalOperation() && (currentTime - updateTime) >= 500) {
            setUpdateTime(currentTime);

            const currentPosition = {
                latitude: arincLat.value,
                longitude: arincLong.value,
                heading: trueHeading,
                altitude: Math.round(altitude),
                verticalSpeed: Math.round(verticalSpeed * 60.0),
            };

            fetch('http://localhost:8080/api/v1/terrain/position', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(currentPosition),
            });
        }
    }, [arincLat, arincLong, verticalSpeed, trueHeading, altitude]);

    return <></>;
};

interface TerrainMapTransitionProps {
    x: number,
    y: number,
    width: number,
    height: number,
    mapdata: string,
    onFinished: () => void,
}

const TerrainMapTransition: React.FC<TerrainMapTransitionProps> = ({ x, y, width, height, mapdata, onFinished }) => {
    const halfWidth = Math.round(width / 2);
    const xCenter = x + halfWidth;
    const bottom = y + height;

    const [clipPath, setClipPath] = useState<string>(`M ${xCenter} ${bottom} L ${xCenter} ${y} L ${xCenter} ${y}`);
    const [passedTime, setPassedTime] = useState<number>(0);
    const clipPathRef = useRef<string>();
    clipPathRef.current = clipPath;

    useUpdate((deltaTime) => {
        const ratio = passedTime / 5000;
        let newClipPath = '';
        if (ratio <= 0.5) {
            const xOffset = Math.max(20, Math.round(width * ratio));
            newClipPath = `M ${xCenter} ${bottom} L ${xCenter + halfWidth - xOffset} ${y} L ${xCenter - halfWidth + xOffset} ${y}`;
        } else if (ratio < 1.0) {
            const yOffset = Math.round(height * (ratio - 0.5) * 2);
            newClipPath = `M ${x} ${y} L ${x} ${y + yOffset} L ${xCenter} ${bottom} L ${x + width} ${y + yOffset} L ${x + width} ${y}`;
        } else {
            const finalPath = `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${bottom} L ${x} ${bottom}`;
            if (clipPathRef.current !== finalPath) {
                newClipPath = `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${bottom} L ${x} ${bottom}`;
                onFinished();
            } else {
                return;
            }
        }

        // workaround if ratio and pixel-roundings result in the same path string
        if (newClipPath === clipPathRef.current) {
            newClipPath = `${newClipPath}z`;
        }

        setClipPath(newClipPath);
        setPassedTime(passedTime + deltaTime);
    });

    return (
        <>
            <defs>
                <clipPath id="maptransition">
                    <path d={clipPath} />
                </clipPath>
            </defs>
            <image
                clipPath="url(#maptransition)"
                x={x}
                y={y}
                width={width}
                height={height}
                xlinkHref={`data:image/png;base64,${mapdata}`}
            />
        </>
    );
};

class MapVisualizationData {
    public LastMap: string | undefined = undefined;

    public CurrentMap: string | undefined = undefined;

    public MapTransitionStart: number = -1;

    public MapChangeInProgress: boolean = false;

    public RerenderTimeout: number | undefined = undefined;

    public CurrentMinimumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public CurrentMaximumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public LastMinimumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public LastMaximumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    constructor(...args) {
        if (args.length !== 0 && args[0] instanceof MapVisualizationData) {
            this.LastMap = args[0].LastMap;
            this.CurrentMap = args[0].CurrentMap;
            this.MapTransitionStart = args[0].MapTransitionStart;
            this.MapChangeInProgress = args[0].MapChangeInProgress;
            this.RerenderTimeout = args[0].RerenderTimeout;
            this.CurrentMinimumElevation = args[0].CurrentMinimumElevation;
            this.CurrentMaximumElevation = args[0].CurrentMaximumElevation;
            this.LastMinimumElevation = args[0].LastMinimumElevation;
            this.LastMaximumElevation = args[0].LastMaximumElevation;
        }
    }
}

export interface TerrainMapProps {
    x: number,
    y: number,
    width: number,
    height: number,
    side: EfisSide,
    clipName: string,
}

export const TerrainMap: React.FC<TerrainMapProps> = ({ x, y, width, height, side, clipName }) => {
    const [mapVisualization, setMapVisualization] = useState<MapVisualizationData>(new MapVisualizationData());
    const [terrOnNdActive] = useSimVar(`L:A32NX_EFIS_TERR_${side}_ACTIVE`, 'boolean', 100);
    const [rangeIndex] = useSimVar(`L:A32NX_EFIS_${side}_ND_RANGE`, 'number', 100);
    const [modeIndex] = useSimVar(`L:A32NX_EFIS_${side}_ND_MODE`, 'number', 100);
    const [gearMode] = useSimVar('GEAR POSITION:0', 'Enum', 100);
    const mapVisualizationRef = useRef<MapVisualizationData>();
    mapVisualizationRef.current = mapVisualization;

    const syncWithRenderer = (timestamp: number) => {
        // wait until the rendering is done
        setTimeout(() => {
            fetch(`http://localhost:8080/api/v1/terrain/ndMapAvailable?display=${side}&timestamp=${timestamp}`).then((response) => {
                if (response.ok) {
                    response.text().then((text) => {
                        if (text !== 'true') {
                            if (terrOnNdActive) {
                                syncWithRenderer(timestamp);
                            }
                            return;
                        }

                        fetch(`http://localhost:8080/api/v1/terrain/ndmap?display=${side}&timestamp=${timestamp}`, { method: 'GET' }).then((response) => response.text().then((imageBase64) => {
                            fetch(`http://localhost:8080/api/v1/terrain/terrainRange?display=${side}&timestamp=${timestamp}`, {
                                method: 'GET',
                                headers: { Accept: 'application/json' },
                            }).then((response) => response.json().then((data) => {
                                if (response.ok) {
                                    if ('minElevation' in data && data.minElevation !== Infinity && 'maxElevation' in data && data.maxElevation !== Infinity) {
                                        let minimumColor = 'rgb(0, 255, 0)';
                                        if (data.minElevationIsWarning) {
                                            minimumColor = 'rgb(255, 255, 0)';
                                        } else if (data.minElevationIsCaution) {
                                            minimumColor = 'rgb(255, 0, 0)';
                                        }
                                        let maximumColor = 'rgb(0, 255, 0)';
                                        if (data.maxElevationIsWarning) {
                                            maximumColor = 'rgb(255, 255, 0)';
                                        } else if (data.maxElevationIsCaution) {
                                            maximumColor = 'rgb(255, 0, 0)';
                                        }

                                        if (mapVisualizationRef.current) {
                                            mapVisualizationRef.current.CurrentMinimumElevation = { altitude: data.minElevation, color: minimumColor };
                                            mapVisualizationRef.current.CurrentMaximumElevation = { altitude: data.maxElevation, color: maximumColor };
                                        }
                                    } else if (mapVisualizationRef.current) {
                                        mapVisualizationRef.current.CurrentMinimumElevation = { altitude: Infinity, color: 'rgb(0, 0, 0)' };
                                        mapVisualizationRef.current.CurrentMaximumElevation = { altitude: Infinity, color: 'rgb(0, 0, 0)' };
                                    }

                                    const newVisualization = new MapVisualizationData(mapVisualizationRef.current);
                                    newVisualization.MapChangeInProgress = true;
                                    newVisualization.CurrentMap = imageBase64;
                                    newVisualization.MapTransitionStart = new Date().getTime();
                                    setMapVisualization(newVisualization);
                                }
                            }));
                        }));
                    });
                }
            });
        }, 200);
    };

    const mapTransitionDone = () => {
        const rerenderVisualization = new MapVisualizationData(mapVisualizationRef.current);
        rerenderVisualization.LastMap = rerenderVisualization.CurrentMap;
        rerenderVisualization.LastMinimumElevation = rerenderVisualization.CurrentMinimumElevation;
        rerenderVisualization.LastMaximumElevation = rerenderVisualization.CurrentMaximumElevation;
        setMapVisualization(rerenderVisualization);

        // preload the "new" old timestamp to avoid flickering
        setTimeout(() => {
            const finalizeMapChange = new MapVisualizationData(mapVisualizationRef.current);
            finalizeMapChange.RerenderTimeout = RerenderingTimeout;
            finalizeMapChange.MapChangeInProgress = false;
            finalizeMapChange.MapTransitionStart = -1;
            setMapVisualization(finalizeMapChange);
        }, 100);
    };

    useUpdate((deltaTime) => {
        if (terrOnNdActive && mapVisualizationRef.current?.RerenderTimeout !== undefined) {
            if (mapVisualizationRef.current.RerenderTimeout <= 0) {
                const newVisualizationData = new MapVisualizationData(mapVisualizationRef.current);
                newVisualizationData.RerenderTimeout = undefined;
                setMapVisualization(newVisualizationData);

                fetch(`http://127.0.0.1:8080/api/v1/terrain/renderMap?display=${side}`).then((response) => response.text().then((text) => {
                    const timestamp = parseInt(text);
                    if (timestamp < 0) {
                        return;
                    }
                    syncWithRenderer(timestamp);
                }));
            } else {
                const newVisualizationData = new MapVisualizationData(mapVisualizationRef.current);
                if (newVisualizationData.RerenderTimeout !== undefined) {
                    newVisualizationData.RerenderTimeout -= deltaTime;
                }
                setMapVisualization(newVisualizationData);
            }
        } else if (!terrOnNdActive && mapVisualizationRef.current?.RerenderTimeout !== undefined) {
            const newVisualizationData = new MapVisualizationData(mapVisualizationRef.current);
            newVisualizationData.RerenderTimeout = undefined;
            setMapVisualization(newVisualizationData);
        }
    });

    useEffect(() => {
        if (!terrOnNdActive) {
            setMapVisualization(new MapVisualizationData());
        } else if (mapVisualizationRef.current?.RerenderTimeout === undefined) {
            const newVisualizationData = new MapVisualizationData(mapVisualizationRef.current);
            newVisualizationData.RerenderTimeout = RerenderingTimeout;
            setMapVisualization(newVisualizationData);
        }

        const displayConfiguration = {
            active: modeIndex !== Mode.PLAN && terrOnNdActive !== 0,
            mapWidth: width,
            mapHeight: height,
            meterPerPixel: rangeSettings[rangeIndex] * 1852 / height,
            arcMode: modeIndex === Mode.ARC,
            gearDown: SimVar.GetSimVarValue('GEAR POSITION:0', 'Enum') !== 1,
        };
        fetch(`http://localhost:8080/api/v1/terrain/displaysettings?display=${side}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(displayConfiguration),
        });
    }, [terrOnNdActive, rangeIndex, modeIndex, gearMode]);

    if (!terrOnNdActive || modeIndex === Mode.PLAN || mapVisualizationRef.current.CurrentMap === undefined) {
        return <></>;
    }

    const lowerBorder = String(Math.floor(mapVisualizationRef.current.LastMinimumElevation.altitude / 100)).padStart(3, '0');
    const upperBorder = String(Math.round(mapVisualizationRef.current.LastMaximumElevation.altitude / 100 + 0.5)).padStart(3, '0');

    return (
        <>
            <g id="map" clipPath={`url(#${clipName})`}>
                {mapVisualizationRef.current.LastMap !== undefined
                    ? (
                        <>
                            <image
                                x={x}
                                y={y}
                                width={width}
                                height={height}
                                xlinkHref={`data:image/png;base64,${mapVisualizationRef.current.LastMap}`}
                            />
                        </>
                    )
                    : <></>}
                {mapVisualizationRef.current.MapChangeInProgress ? (
                    <TerrainMapTransition
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        mapdata={mapVisualizationRef.current.CurrentMap}
                        onFinished={mapTransitionDone}
                    />
                ) : <></>}
            </g>
            <text x={688} y={612} fontSize={23} fill="rgb(0,255,255)">
                TERR
            </text>
            <text x={709} y={639} fontSize={22} fill={mapVisualizationRef.current.LastMaximumElevation.color}>
                {upperBorder}
            </text>
            <rect x={700} y={619} width={54} height={24} strokeWidth={3} stroke="rgb(255,255,0)" fillOpacity={0} />
            <text x={709} y={663} fontSize={23} fill={mapVisualizationRef.current.LastMinimumElevation.color}>
                {lowerBorder}
            </text>
            <rect x={700} y={643} width={54} height={24} strokeWidth={3} stroke="rgb(255,255,0)" fillOpacity={0} />
        </>
    );
};
