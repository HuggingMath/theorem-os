import { gsap } from 'gsap';
import { createSelectionIndicator } from './selectionIndicator';
import type { Locale } from './site';

/** The recorded proof player is used by the proof archive. The caller must ensure a .replay-window exists. */
export function initializeReplay(locale: Locale) {
  const replayRoot = document.querySelector<HTMLElement>('.replay-window')!;
  const element = <T extends HTMLElement = HTMLElement>(selector: string): T => replayRoot.querySelector<T>(selector)!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const text = {
    zh: {
      pause: '暂停回放', resume: '继续播放', play: '播放回放', playing: '播放中', ended: '回放结束', paused: '已暂停',
      step: (step: number, label: string) => `第 ${step} 步，共 4 步：${label}`,
    },
    en: {
      pause: 'Pause replay', resume: 'Resume replay', play: 'Play the replay', playing: 'Playing', ended: 'Replay finished', paused: 'Paused',
      step: (step: number, label: string) => `Step ${step} of 4: ${label}`,
    },
  }[locale];
  const replayTabs = Array.from(replayRoot.querySelectorAll<HTMLButtonElement>('[data-replay-stage]'));
  const replayIndicator = createSelectionIndicator(element('.replay-tabs'), reducedMotion);
  const replayWindow = replayRoot;
  const replayPanels = replayTabs.map(tab => element(`#stage-${tab.dataset.replayStage}`));
  const replayPlay = element<HTMLButtonElement>('#replay-play');
  const replayProgress = element('#replay-progress');
  const replayFill = element('.replay-progress-fill');
  const replayLabels = replayTabs.map(tab => tab.querySelector('span')!.textContent!);
  const replayDurations = [3.2, 4.4, 3.6, 4];
  let replayIndex = replayTabs.length - 1;
  let replayPlaying = false;
  let replayStarted = false;
  let replayComplete = false;
  let replayClock: gsap.core.Timeline | undefined;
  element('.replay-playback').hidden = false;
  replayTabs.forEach(tab => { tab.disabled = false; });

  function updateReplayControls() {
    replayWindow.dataset.replayPlaying = String(replayPlaying);
    replayWindow.dataset.replayCurrent = replayTabs[replayIndex].dataset.replayStage;
    replayWindow.dataset.replayState = replayPlaying ? 'playing' : replayComplete ? 'complete' : 'paused';
    const label = replayPlaying ? text.pause : replayStarted ? text.resume : text.play;
    replayPlay.setAttribute('aria-label', label);
    replayPlay.title = label;
    replayPlay.setAttribute('aria-pressed', String(replayPlaying));
    element<HTMLButtonElement>('#replay-prev').disabled = replayIndex === 0;
    element<HTMLButtonElement>('#replay-next').disabled = replayIndex === replayTabs.length - 1;
    element('#replay-step-number').textContent = `0${replayIndex + 1} / 04`;
    element('#replay-step-label').textContent = replayLabels[replayIndex];
    const status = replayPlaying ? text.playing : replayComplete ? text.ended : text.paused;
    if (element('#replay-status').textContent !== status) element('#replay-status').textContent = status;
    replayProgress.setAttribute('aria-valuenow', String(replayIndex + 1));
    replayProgress.setAttribute('aria-valuetext', text.step(replayIndex + 1, replayLabels[replayIndex]));
  }
  function renderReplayStage(index: number, focus = false) {
    const changed = replayIndex !== index;
    replayIndex = index;
    for (const [position, stage] of replayTabs.entries()) {
      const selected = position === index;
      stage.setAttribute('aria-selected', String(selected));
      stage.tabIndex = selected ? 0 : -1;
      stage.dataset.stepState = position < index ? 'complete' : selected ? 'current' : 'upcoming';
      replayPanels[position].hidden = !selected;
    }
    gsap.set(replayFill, { scaleX: (index + 1) / replayTabs.length });
    replayIndicator.update();
    updateReplayControls();
    if (changed) {
      gsap.killTweensOf(replayPanels);
      gsap.set(replayPanels, { clearProps: 'opacity,transform' });
      if (!reducedMotion.matches) gsap.fromTo(replayPanels[index], { opacity: .45, y: 6 },
        { opacity: 1, y: 0, duration: .28, ease: 'power2.out', clearProps: 'opacity,transform' });
    }
    if (focus) replayTabs[index].focus({ preventScroll: true });
  }
  function pauseReplay() {
    replayClock?.pause();
    replayPlaying = false;
    updateReplayControls();
  }
  function selectReplayStage(tab: HTMLButtonElement, focus = false) {
    pauseReplay();
    replayClock?.kill();
    replayClock = undefined;
    replayStarted = false;
    replayComplete = false;
    renderReplayStage(replayTabs.indexOf(tab), focus);
  }
  function scheduleReplayStage() {
    replayClock?.kill();
    replayClock = gsap.timeline({ onComplete: () => {
      replayClock = undefined;
      if (!replayPlaying) return;
      if (replayIndex === replayTabs.length - 1) {
        replayPlaying = false;
        replayStarted = false;
        replayComplete = true;
        updateReplayControls();
        return;
      }
      renderReplayStage(replayIndex + 1);
      scheduleReplayStage();
    } });
    if (reducedMotion.matches) replayClock.to({}, { duration: replayDurations[replayIndex] });
    else replayClock.fromTo(replayFill, { scaleX: replayIndex / replayTabs.length }, {
      scaleX: (replayIndex + 1) / replayTabs.length, duration: replayDurations[replayIndex], ease: 'none',
    });
  }
  function playReplay(restart = false) {
    const bounds = replayWindow.getBoundingClientRect();
    if (document.hidden || !bounds.width || !bounds.height || bounds.bottom <= 70 || bounds.top >= innerHeight) return;
    if (restart || !replayStarted) {
      replayClock?.kill();
      replayClock = undefined;
      replayComplete = false;
      renderReplayStage(0);
    }
    replayStarted = true;
    replayPlaying = true;
    updateReplayControls();
    if (replayClock) replayClock.resume();
    else scheduleReplayStage();
  }
  replayTabs.forEach(tab => tab.addEventListener('click', () => selectReplayStage(tab)));
  element('.replay-tabs').addEventListener('keydown', event => {
    const index = replayTabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % replayTabs.length;
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index - 1 + replayTabs.length) % replayTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = replayTabs.length - 1;
    else return;
    event.preventDefault();
    selectReplayStage(replayTabs[next], true);
  });
  replayPlay.addEventListener('click', () => { if (replayPlaying) pauseReplay(); else playReplay(); });
  element('#replay-prev').addEventListener('click', () => selectReplayStage(replayTabs[Math.max(0, replayIndex - 1)]));
  element('#replay-next').addEventListener('click', () => selectReplayStage(replayTabs[Math.min(replayTabs.length - 1, replayIndex + 1)]));
  element('#replay-restart').addEventListener('click', () => playReplay(true));
  const replayVisibility = new IntersectionObserver(entries => {
    if ((!entries[0].isIntersecting || entries[0].intersectionRect.height <= 0) && replayPlaying) pauseReplay();
  }, { rootMargin: '-70px 0px 0px 0px' });
  replayVisibility.observe(replayWindow);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { pauseReplay(); replayIndicator.update(false); }
  });
  window.addEventListener('pagehide', event => {
    pauseReplay();
    if (event.persisted) replayIndicator.update(false);
    else replayIndicator.destroy();
  });
  window.addEventListener('pageshow', () => replayIndicator.update(false));
  reducedMotion.addEventListener('change', () => {
    pauseReplay();
    replayClock?.kill();
    replayClock = undefined;
    gsap.killTweensOf(replayPanels);
    gsap.set(replayPanels, { clearProps: 'opacity,transform' });
    gsap.set(replayFill, { scaleX: (replayIndex + 1) / replayTabs.length });
  });
  updateReplayControls();
  return { pause: pauseReplay };
}
