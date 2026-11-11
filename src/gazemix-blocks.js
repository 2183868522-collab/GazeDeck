// Read-only presentation blocks styled with outlines extracted from the supplied
// mixer SVG. They deliberately contain no command handlers or audio writes.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function instrumentDeck({id, live=false, track='', time='', bpm='—', volume='—', playing='', eq={}, effects={}, waveform=''}) {
  const read = (key, value) => live ? `<span data-real-${key}="${id}">—</span>` : escape(value);
  const bands=['low','mid','high'].map(band=>`<div class="mix-eq-block"><small>${band.toUpperCase()}</small><strong>${read(band,eq[band])}</strong></div>`).join('');
  const fx=['reverb','delay','chorus'].map((key,i)=>`<div><small>${['混响','延迟','合唱'][i]}</small><strong>${read(`mix-${key}`,effects[key]??'关闭')}</strong></div>`).join('');
  return `<article class="deck-card mix-deck" data-deck-lane="${id}">
    <div class="mix-eq-strip">${bands}</div>
    <div class="mix-instruments">
      <div class="mix-transport"><div class="deck-home-track-title"><b>${id}</b><strong ${live?`data-real-track="${id}"`:''}>${live?'—':escape(track)}</strong></div>
        <div class="mix-time"><small>TIME</small><strong ${live?`data-real-time-total="${id}"`:`data-deck-time="${id}"`}>${live?'—':escape(time)}</strong><span ${live?`data-real-playing="${id}"`:`data-deck-playing="${id}"`}>${live?'—':escape(playing)}</span></div></div>
      <div class="mix-bpm-block"><small>BPM</small><strong>${read('mix-bpm',bpm)}</strong></div>
      <div class="mix-fx-block"><small>FX</small><div class="mix-fx-values">${fx}</div></div>
      <div class="mix-volume-block"><small>音量</small><strong>${read('volume',volume)}</strong></div>
    </div>
    <div class="mix-wave-block">${live?`<div data-real-waveform="${id}"></div>`:waveform}</div>
  </article>`;
}
