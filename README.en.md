# Shuohua · Voice-controlled tldraw with Jev

**中文** | [English](README.en.md)

Draw on a tldraw canvas by talking to it. Say "draw a circle here", "make it orange",
"a bit bigger", "write *start* inside the circle", "connect the circle to the rectangle" —
the canvas follows along.

Natural-language understanding is done entirely by [Jev](https://docs.typesafe.ai). There is
no local intent parser, no homophone substitution table, and no keyless fallback. Typed input
and the final speech transcript go through the same queue.

## The split that matters

Jev decides **meaning**. Code supplies **facts** and does the writing.

```text
raw transcript / typed text
 → dedupe, ordered queue, live canvas snapshot
 → /api/interpret → Jev typed decisions
 → decision + confidence + verbatim/number checks
 → real target type / existence / lock / page checks
 → tldraw write, program-generated "understood as…"
```

Jev never invents a shape ID and never estimates a size. Reference values such as "make the
second one as wide as the first" are read from the real bounding box at execution time. When
the model is not sure, it asks instead of picking the closest object — and the canvas stays
untouched.

## Run it

Requires Node.js 20.19+ / 22.12+ and npm. Microphone access is needed for voice; the app falls
back to typed input.

```bash
npm install
cp .env.example .env      # fill in TYPESAFE_API_KEY
npm run dev
```

The API server listens on `127.0.0.1:8787`. The key is read by the server only. Without a key
the UI reports "Jev not configured" and nothing is written to the canvas.

### Local speech recognition (optional)

Browser `SpeechRecognition` is the default. For higher accuracy you can run
[whisper.cpp](https://github.com/ggerganov/whisper.cpp) locally and pass `--prompt` for domain
biasing — tone-only confusions like "结束" survive only in a local model. The server probes
`GET /api/asr/status` and switches automatically when a local service is reachable.

## What it can do

- Create circles, rectangles, diamonds and standalone text; place new shapes relative to an
  existing object ("draw a square below it", "…the same size as it").
- Recolor (9 preset colors), fill, stroke, text color; resize as a whole or by width/height;
  exact pixel values are supported, arbitrary HEX is not.
- Write text **into** an existing shape, replace it, or delete it — never as a floating label.
- Move by direction and pixels, to the pointer, or to one side of another object.
- Duplicate, arrange, bind arrows between shapes, undo and redo.
- Align on six edges and reorder z-order; lock and unlock.
- Frame the view: "fit everything" / "focus the selection" — camera-only, never in the undo stack.
- Refer to objects by creation order (the number shown on canvas), by type, or by their
  connections ("the rectangle that connects to *end*").

Deletion and ordinal references are deliberately conservative: an unreadable ordinal, or a
number that does not match the stated shape, is clarified rather than guessed — deletion is not
undoable by voice.

## What it cannot do

Multiply a size by a factor, rotate, set an exact corner radius or stroke width, place a new
shape *inside* another object, or copy an existing object's size as a whole. Unsupported
combinations are refused, not approximated.

Known gaps are recorded honestly in `README.md` (Chinese), including which phrases were
measured against the live Jev service and which were only type-checked.

## Layout

| Path | Role |
| --- | --- |
| `server/app.ts` | API surface and state |
| `server/live/` | Jev questions, context, typed composition |
| `src/live-editor.ts` | Execution and constraints against the real canvas |
| `src/jev-validation.ts` | Protocol validation |
| `src/App.tsx` | Listening, queueing, feedback |

Canvas state lives in browser IndexedDB. There is no account, sync or collaboration. A real
deployment needs the API service and an appropriate tldraw license.

## Verify

```bash
npm test
npm run lint
npm run build
```

Unit tests use mocked Jev responses; they verify the program, not model accuracy.

## License

MIT
