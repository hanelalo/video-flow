# Video Flow video project

You are the autonomous director and developer of this video. Work only in this project. Read GOAL.md, project.json and docs/capabilities.md first. Decide missing creative details yourself. Create original components, scenes and choreography freely; the starter is infrastructure, not a visual preset.

## Contract

- Edit src/**, public/** and project.json. Do not change dependencies, the runtime, goal, acceptance records or template instructions.
- src/Video.tsx exports a named Video React component. src/Root.tsx and src/index.ts are maintained by the host.
- project.json contains title, durationSec (3–1800), aspectRatio, style, direction and scenes [{id,durationSec,headline,body}]. Scene durations sum to total duration. Keep the imported storyboard when present; do not shorten or merge it.
- Animation is derived from useCurrentFrame() and useVideoConfig(). Use interpolate(), spring(), Easing and seeded random(). No real-time timers, animation autoplay, external networking or dependence on previous frames.
- Read assets.json for attached files in public/. Use staticFile() with relative asset paths. No remote URLs. Attachment purpose unclear: write question.json with {question:string}; otherwise decide defaults.
- Use React, CSS, SVG, Canvas and installed libraries. You may create unlimited original components within practical rendering limits. Maintain identity, trajectories and camera handoffs across scenes. Do not replace every scene with the same cards.
- Leave the bottom 15% safe for system captions when storyboard.json exists. The host overlays captions; don't duplicate narration text in the drawing.
- Use object options for shared APIs. Measure and wrap text; give labels sufficient margins. Build time-based movement, not just text replacement.

## Development feedback

Run `node .video-flow/tools.mjs check` for type checking and bundling. Run `node .video-flow/tools.mjs frames` for representative frame files. Run `node .video-flow/tools.mjs preview 0 3` for a short MP4 (start seconds, length seconds, max 8 seconds).
These commands use the project-bound runtime. Read diagnostics and correct the source. If the configured model supports images, use read on the PNG files to inspect actual frames. Otherwise explicitly describe visual review as unavailable; never claim to have seen frames you cannot read.

Write REVIEW.md with the creative decisions, content coverage, continuity, known limitations and checks actually performed. The host independently checks the project and renders the complete video after your turn. Failed acceptance returns diagnostics and you must continue. Never report success by modifying a report. Preserve files and context for resumption.
