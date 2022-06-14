import React, { useEffect, useState, useRef } from 'react';
import { useArinc429Var } from '@instruments/common/arinc429';
import { useSimVar } from '@instruments/common/simVars';
import { Mode, EfisSide, rangeSettings } from '@shared/NavigationDisplay';
import { useUpdate } from '@instruments/common/hooks';

const MapTransitionFramerate = 20;
const MapTransitionDuration = 1.5;
const RerenderingTimeout = 2000;

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
    mapdata: string[],
    onFinished: () => void,
}

const TerrainMapTransition: React.FC<TerrainMapTransitionProps> = ({ x, y, width, height, mapdata, onFinished }) => {
    const frameBuffer: [{ opacity: number, index: number }, React.Dispatch<React.SetStateAction<{ opacity: number, index: number }>>][] = [
        useState({ opacity: 0.01, index: 0 }),
        useState({ opacity: 0.01, index: 0 }),
        useState({ opacity: 0.01, index: 0 }),
        useState({ opacity: 0.01, index: 0 }),
        useState({ opacity: 0.01, index: 0 }),
    ];

    const [frameTimer, setFrameTimer] = useState<NodeJS.Timer | undefined>(undefined);
    const [currentFrame, setCurrentFrame] = useState<number>(0);
    const frameTimerRef = useRef<NodeJS.Timer | undefined>();
    const currentFrameRef = useRef<number>();

    currentFrameRef.current = currentFrame;
    frameTimerRef.current = frameTimer;

    if (frameTimerRef.current === undefined) {
        setFrameTimer(setInterval(() => {
            if (currentFrameRef.current !== undefined && frameTimerRef.current !== undefined) {
                if (currentFrameRef.current >= mapdata.length - 1) {
                    clearInterval(frameTimerRef.current);
                    onFinished();
                } else {
                    for (let i = 0; i < frameBuffer.length; ++i) {
                        frameBuffer[(currentFrameRef.current + i) % frameBuffer.length][1]({ opacity: i === 0 ? 1 : 0.01, index: currentFrameRef.current + i });
                    }

                    setCurrentFrame(currentFrameRef.current + 1);
                }
            }
        }, Math.round(1000 / MapTransitionFramerate)));
    }

    return (
        <>
            {frameBuffer.map((frame) => (
                frame[0].index < mapdata.length && mapdata[frame[0].index] !== undefined
                    ? (
                        <image
                            x={x}
                            y={y}
                            width={width}
                            height={height}
                            opacity={frame[0].opacity}
                            xlinkHref={`data:image/png;base64,${mapdata[frame[0].index]}`}
                        />
                    ) : <></>
            ))}
        </>
    );
};

class MapVisualizationData {
    public TerrainMapBuffer: { opacity: number, data: string }[] = [{ opacity: 0.01, data: '' }, { opacity: 0.01, data: '' }];

    public MapTransitionData: string[] = [];

    public RerenderTimeout: number | undefined = undefined;

    public NextMinimumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public NextMaximumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public MinimumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    public MaximumElevation: { altitude: number, color: string } = { altitude: Infinity, color: 'rgb(0, 0, 0)' };

    constructor(...args) {
        if (args.length !== 0 && args[0] instanceof MapVisualizationData) {
            this.TerrainMapBuffer = args[0].TerrainMapBuffer;
            this.MapTransitionData = args[0].MapTransitionData;
            this.RerenderTimeout = args[0].RerenderTimeout;
            this.NextMinimumElevation = args[0].NextMinimumElevation;
            this.NextMaximumElevation = args[0].NextMaximumElevation;
            this.MinimumElevation = args[0].MinimumElevation;
            this.MaximumElevation = args[0].MaximumElevation;
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

                        fetch(`http://localhost:8080/api/v1/terrain/ndmaps?display=${side}&timestamp=${timestamp}`).then((response) => response.json().then((imageBase64) => {
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
                                            mapVisualizationRef.current.NextMinimumElevation = { altitude: data.minElevation, color: minimumColor };
                                            mapVisualizationRef.current.NextMaximumElevation = { altitude: data.maxElevation, color: maximumColor };
                                        }
                                    } else if (mapVisualizationRef.current) {
                                        mapVisualizationRef.current.NextMinimumElevation = { altitude: Infinity, color: 'rgb(0, 0, 0)' };
                                        mapVisualizationRef.current.NextMaximumElevation = { altitude: Infinity, color: 'rgb(0, 0, 0)' };
                                    }

                                    const newVisualization = new MapVisualizationData(mapVisualizationRef.current);
                                    newVisualization.MapTransitionData = imageBase64;
                                    if (newVisualization.TerrainMapBuffer[0].opacity === 0.01) {
                                        newVisualization.TerrainMapBuffer[0].data = imageBase64[imageBase64.length - 1];
                                    } else {
                                        newVisualization.TerrainMapBuffer[1].data = imageBase64[imageBase64.length - 1];
                                    }

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
        if (rerenderVisualization.TerrainMapBuffer[0].opacity === 0.01) {
            rerenderVisualization.TerrainMapBuffer[0].opacity = 1;
            rerenderVisualization.TerrainMapBuffer[1].opacity = 0.01;
        } else {
            rerenderVisualization.TerrainMapBuffer[0].opacity = 0.01;
            rerenderVisualization.TerrainMapBuffer[1].opacity = 1;
        }
        rerenderVisualization.MapTransitionData = [];
        rerenderVisualization.MinimumElevation = rerenderVisualization.NextMinimumElevation;
        rerenderVisualization.MaximumElevation = rerenderVisualization.NextMaximumElevation;
        rerenderVisualization.RerenderTimeout = RerenderingTimeout;
        setMapVisualization(rerenderVisualization);
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

        const meterPerPixel = Math.round(rangeSettings[rangeIndex] * 1852 / height);
        const displayConfiguration = {
            active: modeIndex !== Mode.PLAN && terrOnNdActive !== 0,
            mapWidth: width,
            mapHeight: height,
            meterPerPixel: meterPerPixel + (10 - (meterPerPixel % 10)),
            mapTransitionTime: MapTransitionDuration,
            mapTransitionFps: MapTransitionFramerate,
            arcMode: modeIndex === Mode.ARC,
            gearDown: SimVar.GetSimVarValue('GEAR POSITION:0', 'Enum') !== 1,
        };
        fetch(`http://localhost:8080/api/v1/terrain/displaysettings?display=${side}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(displayConfiguration),
        });
    }, [terrOnNdActive, rangeIndex, modeIndex, gearMode]);

    if (!terrOnNdActive || modeIndex === Mode.PLAN) {
        return <></>;
    }

    let lowerBorder = '';
    if (Number.isFinite(mapVisualizationRef.current.MinimumElevation.altitude)) {
        lowerBorder = String(Math.floor(mapVisualizationRef.current.MinimumElevation.altitude / 100)).padStart(3, '0');
    }
    let upperBorder = '';
    if (Number.isFinite(mapVisualizationRef.current.MaximumElevation.altitude)) {
        upperBorder = String(Math.round(mapVisualizationRef.current.MaximumElevation.altitude / 100 + 0.5)).padStart(3, '0');
    }

    return (
        <>
            <g id="map" clipPath={`url(#${clipName})`}>
                {mapVisualization.TerrainMapBuffer.map((frame) => (
                    frame.data !== ''
                        ? (
                            <image
                                x={x}
                                y={y}
                                width={width}
                                height={height}
                                opacity={frame.opacity}
                                xlinkHref={`data:image/png;base64,${frame.data}`}
                            />
                        ) : <></>
                ))}
                {mapVisualization.MapTransitionData.length !== 0 ? (
                    <TerrainMapTransition
                        x={x}
                        y={y}
                        width={width}
                        height={height}
                        mapdata={mapVisualization.MapTransitionData}
                        onFinished={mapTransitionDone}
                    />
                ) : <></>}
            </g>
            {upperBorder !== ''
                ? (
                    <>
                        <text x={688} y={612} fontSize={23} fill="rgb(0,255,255)">
                            TERR
                        </text>
                        <text x={709} y={639} fontSize={22} fill={mapVisualizationRef.current.MaximumElevation.color}>
                            {upperBorder}
                        </text>
                        <rect x={700} y={619} width={54} height={24} strokeWidth={3} stroke="rgb(255,255,0)" fillOpacity={0} />
                        <text x={709} y={663} fontSize={23} fill={mapVisualizationRef.current.MinimumElevation.color}>
                            {lowerBorder}
                        </text>
                        <rect x={700} y={643} width={54} height={24} strokeWidth={3} stroke="rgb(255,255,0)" fillOpacity={0} />
                    </>
                ) : <></>}
        </>
    );
};
