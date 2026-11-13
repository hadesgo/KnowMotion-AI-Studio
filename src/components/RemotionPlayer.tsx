import { Player, type PlayerRef } from "@remotion/player";
import {
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KnowledgeComposition } from "../remotion/SceneRenderer";
import type { CompositionDsl } from "../remotion/schema";
import { formatTime } from "../utils";
import { Button, IconButton } from "./ui";
import "./RemotionPlayer.css";

export function RemotionPlayer({
  composition,
  singleScene = false,
  className = "",
}: {
  composition: CompositionDsl;
  singleScene?: boolean;
  className?: string;
}) {
  const playerRef = useRef<PlayerRef>(null);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const handlePlay = () => setPlaying(true);
    const handlePause = () => setPlaying(false);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    return () => {
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
    };
  }, [composition.id]);

  return (
    <div className={`remotion-player ${className}`}>
      <div className="remotion-player__surface">
        <Player
          ref={playerRef}
          component={KnowledgeComposition}
          inputProps={{ composition }}
          durationInFrames={composition.durationInFrames}
          initialFrame={Math.min(
            composition.fps,
            Math.max(0, composition.durationInFrames - 1),
          )}
          compositionWidth={composition.width}
          compositionHeight={composition.height}
          fps={composition.fps}
          controls={!singleScene}
          loop={singleScene}
          autoPlay={false}
          clickToPlay
          doubleClickToFullscreen
          style={{ width: "100%", height: "100%" }}
        />
      </div>
      <div className="remotion-player__transport">
        <div>
          <IconButton
            label="回到开头"
            onClick={() => playerRef.current?.seekTo(0)}
          >
            <RotateCcw size={15} />
          </IconButton>
          <Button
            variant={playing ? "soft" : "primary"}
            size="sm"
            icon={
              playing ? (
                <Pause size={14} fill="currentColor" />
              ) : (
                <Play size={14} fill="currentColor" />
              )
            }
            onClick={() =>
              playing ? playerRef.current?.pause() : playerRef.current?.play()
            }
          >
            {playing ? "暂停" : "播放"}
          </Button>
          <span>
            {formatTime(
              composition.durationInFrames / composition.fps,
            )}{" "}
            · {composition.width}×{composition.height} · {composition.fps} FPS
          </span>
        </div>
        <div>
          <IconButton
            label={muted ? "打开声音" : "静音"}
            onClick={() => {
              if (muted) playerRef.current?.unmute();
              else playerRef.current?.mute();
              setMuted(!muted);
            }}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </IconButton>
          <IconButton
            label="全屏"
            onClick={() => playerRef.current?.requestFullscreen()}
          >
            <Maximize2 size={15} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
