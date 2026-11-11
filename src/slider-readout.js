const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Keep the number beside the actual range thumb. The source element remains the
// popup's existing readout, so none of the control or confirmation logic changes.
export function bindSliderReadout(range, source, { hideRow = true, enabled = true } = {}) {
  if (!range || !source) throw new Error('滑块数值绑定缺少输入或读数元素');
  const wrapper = document.createElement('div');
  wrapper.className = 'thumb-readout';
  range.before(wrapper);
  wrapper.append(range);
  const bubble = document.createElement('output');
  bubble.className = 'thumb-readout-value';
  bubble.setAttribute('for', range.id);
  wrapper.append(bubble);

  const sourceRow = hideRow ? source.parentElement : source;
  const values = hideRow && sourceRow?.parentElement?.classList.contains('sc-live-values')
    ? sourceRow.parentElement : null;
  let active = false;
  let queued = false;

  function sync() {
    bubble.textContent = source.textContent;
    if (!active || !range.isConnected || !wrapper.getClientRects().length) return;
    const width = range.getBoundingClientRect().width;
    if (!width) return;
    const min = Number(range.min), max = Number(range.max), value = Number(range.value);
    const fraction = max > min ? clamp((value - min) / (max - min), 0, 1) : 0.5;
    const thumbSize = 20;
    const thumbX = thumbSize / 2 + (width - thumbSize) * fraction;
    const bubbleWidth = bubble.getBoundingClientRect().width;
    const half = Math.min(width / 2, bubbleWidth / 2);
    bubble.style.left = `${clamp(thumbX, half, width - half)}px`;
    wrapper.style.paddingTop = `${Math.ceil(bubble.getBoundingClientRect().height) + 14}px`;
  }
  function schedule() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; sync(); });
  }
  function setEnabled(next) {
    active = !!next;
    wrapper.classList.toggle('is-active', active);
    sourceRow.classList.toggle('thumb-readout-source-hidden', active);
    if (values) values.classList.toggle('thumb-readout-values-empty',
      [...values.children].every(child => child.classList.contains('thumb-readout-source-hidden')));
    wrapper.classList.toggle('hidden', !active && range.classList.contains('hidden'));
    if (!active) wrapper.style.paddingTop = '';
    schedule();
  }

  range.addEventListener('input', schedule);
  range.addEventListener('change', schedule);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(schedule);
    observer.observe(source, { childList: true, characterData: true, subtree: true });
    observer.observe(range, { attributes: true, attributeFilter: ['min', 'max'] });
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(range);
  else window.addEventListener('resize', schedule);
  setEnabled(enabled);
  return { setEnabled, sync: schedule };
}
