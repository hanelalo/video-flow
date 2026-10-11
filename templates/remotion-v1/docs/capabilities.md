# Installed capabilities

The exact dependency versions are recorded in package.json and package-lock.json. Packages are provided read-only. You can inspect package declarations through node_modules.

- react / react-dom: custom components, CSS flex/grid layout, SVG, reusable objects.
- remotion: useCurrentFrame, useVideoConfig, interpolate, spring, Easing, random, Sequence, AbsoluteFill, Img, Audio, staticFile.
- @remotion/transitions: TransitionSeries and transitions. Keep timing aligned with the project specification.
- @remotion/shapes: SVG shape generation and components.
- @remotion/paths: path length, interpolation and path operations.
- @remotion/layout-utils: text measurement / fitting. Look up exact exported declarations before using an unfamiliar API.
- lucide-react: icons, used as supporting visual elements rather than the entire subject.
- TypeScript: strict checking of components, imports, props and function calls.

## Minimal frame-driven component

```tsx
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
export const Video: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, width} = useVideoConfig();
  const reveal = spring({frame, fps, config: {damping: 20}});
  const x = interpolate(frame, [0, fps * 3], [width * .2, width * .8], {extrapolateRight: 'clamp'});
  return <AbsoluteFill style={{background: '#071420'}}>
    <svg width="100%" height="100%"><circle cx={x} cy={300} r={40 * reveal} fill="#60eccb" /></svg>
  </AbsoluteFill>;
};
```

Design your own composition, artwork and movement. Inline CSS uses React's CSSProperties types. For text use width constraints, lineHeight and deliberate overflow behavior. Avoid scrollbars and text relying on browser interactions.

The host measures visible DOM / SVG text against the composition bounds. If a specific text object intentionally enters from outside the frame or is deliberately cropped, add `data-allow-overflow` to that object only and explain the choice in REVIEW.md. Do not put this attribute on an entire scene to hide layout errors. Canvas text has no DOM bounds; measure it yourself.

The default composition ID is Video. Frame zero is the start; the last frame is durationInFrames-1. You can import project.json or storyboard.json with resolveJsonModule. The system creates an immutable spec during acceptance and records the source hash.
