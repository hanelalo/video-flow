import React, {useLayoutEffect} from 'react';
import {Composition, AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {Video} from './Video';
import spec from '../.video-flow/spec.json';

type Storyboard = {scenes: {startSec: number; endSec: number; cues: {startSec: number; endSec: number; text: string}[]}[]};
const storyboard = (spec as {storyboard: Storyboard | null}).storyboard;

const LayoutObserver: React.FC = () => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();
  useLayoutEffect(() => {
    const issues: string[] = [];
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (element: Element) => { let style = styles.get(element); if (!style) { style = getComputedStyle(element); styles.set(element, style); } return style; };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-vf-artwork] *'))) {
      if (el.closest('[data-allow-overflow]')) continue;
      const directText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (!directText) continue;
      const style = styleOf(el), rect = el.getBoundingClientRect();
      let opacity = 1;
      for (let parent: Element | null = el; parent; parent = parent.parentElement) opacity *= Number(styleOf(parent).opacity);
      if (style.visibility === 'hidden' || opacity < .05 || !rect.width || !rect.height) continue;
      if (rect.left < -2 || rect.top < -2 || rect.right > width + 2 || rect.bottom > height + 2 || (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2)) issues.push((el.textContent || '').trim().slice(0, 80));
    }
    if (issues.length) console.warn('[vf-layout]' + JSON.stringify({frame, issues: issues.slice(0, 20)}));
  }, [frame, width, height]);
  return null;
};

const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps, height} = useVideoConfig();
  const time = frame / fps;
  const scene = storyboard?.scenes.find(s => time >= s.startSec && time < s.endSec);
  const cue = scene?.cues.find(c => time - scene.startSec >= c.startSec && time - scene.startSec < c.endSec);
  if (!cue) return null;
  return <AbsoluteFill style={{justifyContent: 'flex-end', alignItems: 'center', paddingBottom: height * .025, pointerEvents: 'none'}}>
    <div style={{maxWidth: '90%', padding: '10px 24px', borderRadius: 10, background: 'rgba(5,10,20,.88)', color: '#f3f6fc', fontSize: height * .035, lineHeight: 1.5, textAlign: 'center', fontFamily: '"PingFang SC","Microsoft YaHei",sans-serif'}}>{cue.text}</div>
  </AbsoluteFill>;
};
const WithCaptions: React.FC = () => <AbsoluteFill><AbsoluteFill data-vf-artwork><Video /></AbsoluteFill><Captions /><LayoutObserver /></AbsoluteFill>;
export const Root: React.FC = () => <Composition id="Video" component={WithCaptions} durationInFrames={spec.durationInFrames} width={spec.width} height={spec.height} fps={spec.fps} />;
