"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Chip, LinearProgress, Paper, TextField, Typography, useTheme } from "@mui/material";
import type { Theme } from "@mui/material/styles";
import { postTurn, resetSession, type TurnEvent } from "@/lib/api";
import { GM_BASE_URL } from "@/lib/config";
import { toDisplaySegments, type DisplaySegment } from "@/lib/paralinguistic";
import { charsVisible, resolveBeatDuration, tagAwareReveal } from "@/lib/reveal";
import { appendTurnBeat as appendBeatToLog, updateTurnBeat as updateBeatInLog } from "@/lib/chatLog";
import type { BeatState, LogEntry } from "@/lib/chatLog";

/**
 * The campfire chat: the party types intent and hands off the conch, the
 * pondering filler plays while the GM thinks, then the narration plays
 * beat-by-beat aloud while the text reveals in sync with the audio. Beats
 * stream from gm's NDJSON turn contract and play strictly in order.
 */

type Status = "idle" | "pondering" | "speaking";

interface QueuedBeat {
  audioHref: string | null;
  durationMs: number | null;
  degraded: boolean;
  text: string;
}

const TEXT_CPS = 16; // text-pace fallback (settled §5)

/** Display cost of a beat: text chars count, tags cost a fixed 1. */
function displayLength(segments: DisplaySegment[]): number {
  let total = 0;
  for (const segment of segments) total += segment.type === "text" ? segment.value.length : 1;
  return total;
}

/** Absolute URL for an href from the gm wire contract (relative when same-origin). */
function absUrl(href: string): string {
  return `${GM_BASE_URL}${href}`;
}

export default function ChatBox() {
  const theme: Theme = useTheme();
  const [status, setStatus] = useState<Status>("idle");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const sceneGeneration = useRef(0);
  const turnSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const audioElements = useRef(new Set<HTMLAudioElement>());

  const busy = status !== "idle" || resetting;

  const trackAudio = useCallback((audio: HTMLAudioElement): void => {
    audioElements.current.add(audio);
    const forget = (): void => { audioElements.current.delete(audio); };
    audio.addEventListener("ended", forget, { once: true });
    audio.addEventListener("error", forget, { once: true });
  }, []);

  useEffect(() => () => {
    sceneGeneration.current++;
    activeController.current?.abort();
    for (const audio of audioElements.current) audio.pause();
    audioElements.current.clear();
  }, []);

  // Keep the feed pinned to the newest line (TV across the room).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, error, degraded]);

  /** Update only the beat belonging to this turn; prior turns remain immutable. */
  const updateTurnBeat = useCallback((turnId: string, beatIndex: number, patch: Partial<BeatState>, generation: number): void => {
    if (sceneGeneration.current !== generation) return;
    setLog((prev) => sceneGeneration.current === generation
      ? updateBeatInLog(prev, turnId, beatIndex, patch)
      : prev);
  }, []);

  const appendTurnBeat = useCallback((turnId: string, beat: BeatState, generation: number): void => {
    if (sceneGeneration.current !== generation) return;
    setLog((prev) => sceneGeneration.current === generation
      ? appendBeatToLog(prev, turnId, beat)
      : prev);
  }, []);

  /**
   * Reveal one beat in sync with its audio: audio-pace via durationMs (or
   * the element's own metadata), text-pace fallback when audio is absent,
   * degraded, or fails to play. Playback failures never crash the loop —
   * the beat falls back to text pace and the turn continues. Audio mode
   * completes on the element's ended event or a pace bound (+250ms grace);
   * text mode completes when every char is visible.
   */
  const playBeat = useCallback(
    (beat: QueuedBeat, turnId: string, beatIndex: number, generation: number, prefetched?: HTMLAudioElement): Promise<void> => {
      const segments = toDisplaySegments(beat.text);
      const total = displayLength(segments);

      // Reuse the prefetched element when one exists (download already
      // started when the beat event arrived — overlaps the previous
      // beat's playback); fall back to constructing now.
      let audio: HTMLAudioElement | null = null;
      let audioBroken = beat.degraded || beat.audioHref === null;
      let fallbackStartedAt = performance.now();
      if (!audioBroken && beat.audioHref !== null) {
        audio = prefetched ?? new Audio(absUrl(beat.audioHref));
        trackAudio(audio);
        audio.addEventListener("error", () => {
          audioBroken = true;
          fallbackStartedAt = performance.now();
        });
      }
      const fallbackMs = (total / TEXT_CPS) * 1000;

      if (audio !== null) {
        audio.play().catch(() => {
          audioBroken = true; // NotAllowedError, dead URL, 404…
          fallbackStartedAt = performance.now();
        });
      }

      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          if (audio !== null) audioElements.current.delete(audio);
          resolve();
        };
        const frame = (): void => {
          if (sceneGeneration.current !== generation) {
            audio?.pause();
            finish();
            return;
          }
          // audio.currentTime is the playback truth and stays at zero through
          // preload/decode; wall-clock pacing is used only without working audio.
          const elapsed = audio !== null && !audioBroken
            ? audio.currentTime * 1000
            : performance.now() - fallbackStartedAt;
          const durationMs = resolveBeatDuration({
            durationMs: beat.durationMs,
            audioDuration: audio !== null && Number.isFinite(audio.duration) ? audio.duration * 1000 : null,
          });
          const boundMs = durationMs === null ? null : durationMs + 250;
          if (audioBroken) {
            const visible = charsVisible(elapsed, { total, durationMs: null, cps: TEXT_CPS });
            updateTurnBeat(turnId, beatIndex, { revealed: visible }, generation);
            if (visible >= total) {
              updateTurnBeat(turnId, beatIndex, { revealed: total }, generation);
              finish();
              return;
            }
          } else {
            const visible = charsVisible(elapsed, {
              total,
              durationMs,
            });
            updateTurnBeat(turnId, beatIndex, { revealed: visible }, generation);
            if ((audio?.ended ?? true) || (boundMs !== null && elapsed >= boundMs)) {
              updateTurnBeat(turnId, beatIndex, { revealed: total }, generation);
              finish();
              return;
            }
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    },
    [trackAudio, updateTurnBeat],
  );

  const submit = useCallback(
    async (rawText: string): Promise<void> => {
      const text = rawText.trim();
      if (text.length === 0) return;

      setDraft("");
      setError(null);
      setDegraded(false);
      const generation = sceneGeneration.current;
      const turnId = `turn-${Date.now().toString(36)}-${++turnSequence.current}`;
      setLog((prev) => [...prev, { kind: "party", text }]);
      setStatus("pondering");
      const controller = new AbortController();
      activeController.current = controller;

      // Beats arrive in order from the wire and play strictly sequentially:
      // playback of beat N+1 starts only after beat N finishes.
      // Per-beat prefetched Audio elements (keyed by href), created when the
      // beat event arrives so downloads overlap the previous beat's
      // playback.
      const prefetched = new Map<string, HTMLAudioElement>();
      const queue: QueuedBeat[] = [];
      let queueClosed = false;
      const wakeSlot: { fn: (() => void) | null } = { fn: null };
      const enqueue = (beat: QueuedBeat): void => {
        queue.push(beat);
        const wake = wakeSlot.fn;
        wakeSlot.fn = null;
        wake?.();
      };
      const nextBeat = async (): Promise<QueuedBeat | null> => {
        for (;;) {
          const beat = queue.shift();
          if (beat !== undefined) return beat;
          if (queueClosed) return null;
          await new Promise<void>((resolve) => {
            wakeSlot.fn = resolve;
          });
        }
      };

      const onEvent = (event: TurnEvent): void => {
        if (sceneGeneration.current !== generation) return;
        if (event.type === "ack") {
          setLog((prev) => sceneGeneration.current === generation
            ? [...prev, { kind: "filler", text: event.filler.text }]
            : prev);
          if (event.filler.audioHref !== null) {
            // Instant audio behind the turn; failures are silent (the
            // filler text still shows).
            const audio = new Audio(absUrl(event.filler.audioHref));
            trackAudio(audio);
            void audio.play().catch(() => audioElements.current.delete(audio));
          }
        } else if (event.type === "beat") {
          setStatus("speaking");
          if (event.degraded) setDegraded(true);
          // Prefetch: create the Audio element eagerly so the next beat's
          // download overlaps the current beat's playback; playBeat reuses
          // it instead of constructing at play-start.
          if (event.audioHref !== null && !event.degraded && !prefetched.has(event.audioHref)) {
            const el = new Audio(absUrl(event.audioHref));
            el.preload = "auto";
            trackAudio(el);
            prefetched.set(event.audioHref, el);
          }
          enqueue({
            audioHref: event.audioHref,
            durationMs: event.durationMs,
            degraded: event.degraded,
            text: event.text,
          });
        } else if (event.type === "error") {
          setError(event.message);
        }
        // done: handled via stream close below.
      };

      // Consume beats concurrently with the HTTP stream: each completed
      // synthesis can start playing without waiting for later beats/turn close.
      const playback = (async (): Promise<void> => {
        let beatIndex = 0;
        for (;;) {
          const beat = await nextBeat();
          if (beat === null || sceneGeneration.current !== generation) return;
          setStatus("speaking");
          appendTurnBeat(turnId, {
            segments: toDisplaySegments(beat.text),
            revealed: 0,
            degraded: beat.degraded,
          }, generation);
          await playBeat(beat, turnId, beatIndex, generation,
            beat.audioHref !== null ? prefetched.get(beat.audioHref) : undefined);
          beatIndex++;
        }
      })();

      try {
        await postTurn(text, onEvent, { signal: controller.signal });
      } catch (err) {
        if (sceneGeneration.current === generation) {
          setError(err instanceof Error ? err.message : "gm turn failed");
        }
      } finally {
        queueClosed = true;
        wakeSlot.fn?.();
      }

      try {
        await playback;
      } finally {
        if (activeController.current === controller) activeController.current = null;
        if (sceneGeneration.current === generation) setStatus("idle");
      }
    },
    [appendTurnBeat, playBeat, trackAudio],
  );

  const handleSubmit = useCallback((): void => {
    void submit(draft);
  }, [submit, draft]);

  const handleNewScene = useCallback(async (): Promise<void> => {
    const generation = ++sceneGeneration.current;
    activeController.current?.abort();
    activeController.current = null;
    for (const audio of audioElements.current) audio.pause();
    audioElements.current.clear();
    setResetting(true);
    try {
      await resetSession();
      if (sceneGeneration.current !== generation) return;
      setLog([]);
      setDegraded(false);
      setError(null);
    } catch (err) {
      if (sceneGeneration.current === generation) {
        setError(err instanceof Error ? err.message : "could not reset the scene");
      }
    } finally {
      if (sceneGeneration.current === generation) {
        setStatus("idle");
        setResetting(false);
      }
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <Paper elevation={2} sx={{ mt: { xs: 2, sm: 3 }, p: { xs: 2, sm: 3 } }}>
      {error !== null && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {degraded && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          degraded — TTS unavailable, narration as text
        </Alert>
      )}
      {status === "pondering" && (
        <div aria-live="polite">
          <LinearProgress sx={{ mb: 1 }} />
          <Typography variant="body2" sx={{ color: "text.secondary", fontStyle: "italic", mb: 1 }}>
            The GM ponders…
          </Typography>
        </div>
      )}

      <div
        ref={logRef}
        aria-label="narration feed"
        aria-live="polite"
        style={{
          minHeight: "40vh",
          maxHeight: "60vh",
          overflowY: "auto",
          padding: theme.spacing(1, 0.5),
        }}
      >
        {log.map((entry, index) => {
          if (entry.kind === "party") {
            return (
              <Typography
                key={index}
                component="p"
                sx={{
                  typography: "body1",
                  fontSize: { xs: "1rem", sm: "1.1rem", md: "1.25rem" },
                  fontWeight: 600,
                  color: "text.primary",
                  lineHeight: 1.6,
                  my: 1.5,
                }}
              >
                {entry.text}
              </Typography>
            );
          }
          if (entry.kind === "filler") {
            return (
              <Typography
                key={index}
                component="p"
                sx={{
                  typography: "body1",
                  fontSize: { xs: "0.95rem", sm: "1.05rem" },
                  color: "text.secondary",
                  fontStyle: "italic",
                  lineHeight: 1.6,
                  my: 1.5,
                }}
              >
                {entry.text}
              </Typography>
            );
          }
          return (
            <div key={entry.turnId}>
              {entry.beats.map((beat, beatIndex) => {
                const revealed = tagAwareReveal(beat.segments, beat.revealed);
                return (
                  <Typography
                    key={beatIndex}
                    component="p"
                    sx={{
                      typography: "body1",
                      fontSize: { xs: "1.05rem", sm: "1.15rem", md: "1.3rem" },
                      lineHeight: 1.7,
                      color: "text.primary",
                      my: 1.5,
                    }}
                  >
                    {revealed.map((segment, segmentIndex) =>
                      segment.type === "text" ? (
                        <span key={segmentIndex}>{segment.value}</span>
                      ) : (
                        <Chip
                          key={segmentIndex}
                          size="small"
                          variant="outlined"
                          color="secondary"
                          label={segment.label}
                          sx={{ mx: 0.5, verticalAlign: "middle" }}
                        />
                      ),
                    )}
                  </Typography>
                );
              })}
            </div>
          );
        })}
      </div>

      <TextField
        fullWidth
        multiline
        minRows={2}
        maxRows={4}
        label="Take the conch…"
        aria-label="Party intent"
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        sx={{
          mt: 2,
          "& .MuiInputBase-input": {
            fontSize: { xs: "1rem", sm: "1.05rem" },
          },
        }}
      />
      <div style={{ display: "flex", gap: theme.spacing(2), marginTop: theme.spacing(2) }}>
        <Button
          variant="contained"
          color="primary"
          onClick={handleSubmit}
          disabled={busy || draft.trim().length === 0}
          sx={{ [theme.breakpoints.up("sm")]: { px: 4 } }}
        >
          Hand off
        </Button>
        <Button variant="text" color="secondary" onClick={handleNewScene} disabled={busy}>
          New scene
        </Button>
      </div>
    </Paper>
  );
}
