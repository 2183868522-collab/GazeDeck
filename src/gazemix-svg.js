import {mixerSVG,blockSVG} from './gazemix-svg-assets.js';
const directions=['up','down','left','right'],gestures=['上看','下看','左看','右看'];
const categories=['tracks','presets','sound','speed'];
const labels={outer:['曲目与播放管理','音色预设','声音与效果','速度控制'],inner:['取消选择／返回外圈','同时控制 AB','控制','控制']};
const segments=['ab cdef'.replaceAll(' ',''),'bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
const clock=value=>{if(!Number.isFinite(value)||value<0)return'—';const n=Math.floor(value);return`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;};
export const inlineMixer=()=>mixerSVG;

// Existing buttons remain the sole command entry points on secondary pages.
// Inline decoration never intercepts a click or participates in tab order.
export function applySVGBlocks(root,nav,observing=false) {
  const orbit=root.querySelector('.deck-orbit');if(!orbit||!orbit.insertAdjacentHTML)return;
  const board=orbit.querySelector('.mix-inline-board');
  if(board){
    board.querySelectorAll('[data-mix-nav]').forEach(group=>{
      const tier=group.dataset.mixNav,index=directions.indexOf(group.dataset.side);
      const active=(nav.stage==='outer')===(tier==='outer')&&!observing;
      group.setAttribute('role','button');group.setAttribute('aria-disabled',String(!active));
      group.setAttribute('tabindex',active?'0':'-1');
      if(active){group.dataset.mixCommand='';group.dataset.deckCommand=gestures[index];}
      else{delete group.dataset.mixCommand;delete group.dataset.deckCommand;}
      group.querySelector('[data-mix-nav-label]').textContent=labels[tier][index];
      group.setAttribute('aria-label',`${gestures[index]} · ${labels[tier][index]}`);
      const selected=tier==='outer'&&categories[index]===nav.category;
      group.classList.toggle('mix-svg-selected',selected);
    });
    return;
  }
  if(!orbit.querySelector('.mix-frame-svg')) orbit.insertAdjacentHTML('afterbegin',blockSVG.chassis.replace('<svg ','<svg class="mix-frame-svg" aria-hidden="true" '));
  orbit.querySelectorAll('.deck-direction,.deck-intro-side,.deck-intro-enter').forEach(button=>{
    if(button.querySelector('.mix-zone-svg'))return;
    const side=directions.find(side=>button.classList.contains('deck-direction-'+side))||'down';
    const shape=blockSVG['outer-'+side];
    button.insertAdjacentHTML('afterbegin',shape.replace('<svg ','<svg class="mix-zone-svg" aria-hidden="true" '));
  });
}

function setText(node,value){if(node&&node.textContent!==String(value))node.textContent=String(value);}
function setDigits(node,value){
  if(!node)return;
  const digits=node.querySelectorAll('[data-gazemix-digit]');
  const text=String(value).replace(':','');
  const valid=/^\d+$/.test(text)&&text.length<=digits.length;
  const chars=valid?text.padStart(digits.length,'0'):'-'.repeat(digits.length);
  digits.forEach((digit,i)=>digit.querySelectorAll('[data-gazemix-segment]').forEach(seg=>seg.setAttribute('opacity',(chars[i]==='-'?'g':segments[Number(chars[i])]).includes(seg.dataset.gazemixSegment)?'1':'.13')));
  node.setAttribute('aria-label',String(value));
}

// Only current verified reads reach this function in live mode. Missing values
// are dashes, never retained example values from the original illustration.
export function updateMixerDeck(root,id,{name,elapsed,duration,bpm,volume,volumeUnit='%',meterLevel,eq={},effects={},playing=null,waveform=null,live=false}) {
  const board=root.querySelector('.mix-inline-board');if(!board)return;
  const key='deck.'+id.toLowerCase()+'.';
  const field=suffix=>board.querySelector(`[data-gazemix-value="${key+suffix}"]`);
  const title=field('trackName');setText(title,name||'—');title?.setAttribute('title',name||'—');
  setDigits(field('elapsed'),Number.isFinite(elapsed)&&elapsed<6000?clock(elapsed):'—');
  setText(field('duration'),'/ '+clock(duration));
  setDigits(field('bpm'),Number.isFinite(bpm)&&bpm>0&&bpm<1000?Math.round(bpm):'—');
  for(const band of ['low','mid','high'])setText(field('eq.'+band+'Db'),Number.isFinite(eq[band])?(eq[band]>0?'+':'')+Number(eq[band].toFixed(1)):'—');
  for(const effect of ['reverb','delay','chorus'])setText(field('fx.'+effect+'Pct'),Number.isFinite(effects[effect])?Math.round(effects[effect]):'—');
  setText(field('volumePct'),Number.isFinite(volume)?Number(volume.toFixed(1)):'—');
  const volumeGroup=board.querySelector('#gazemix-deck-'+id.toLowerCase()+'-volume');
  const unit=[...volumeGroup.querySelectorAll('text')].find(el=>el.textContent==='%'||el.dataset.mixUnit);
  if(unit){unit.dataset.mixUnit='';setText(unit,volumeUnit);}
  field('volumePct')?.setAttribute('font-size',volumeUnit==='dB'?'22':'27');
  field('volumeMeter')?.querySelectorAll('[data-gazemix-level-step]').forEach(step=>{
    step.setAttribute('fill',id==='A'?'#a0e0c9':'#ccc0eb');
    step.setAttribute('opacity',Number.isFinite(meterLevel)&&Number(step.dataset.gazemixLevelStep)<=Math.round(Math.max(0,Math.min(1,meterLevel))*10)?'1':'.13');
  });
  const transport=field('transportIcon');
  if(transport){transport.setAttribute('opacity',playing===null?'.25':'1');transport.setAttribute('aria-label',playing===null?'—':playing?'Playing':'Paused');
    // Reuse the SVG transport viewport, with its original outline and origin.
    transport.setAttribute('d',playing?'M8 4V20M16 4V20':'M7 4L20 12L7 20Z');
  }
  const host=board.querySelector(`[data-mix-wave="${id}"]`);
  if(host){
    if(live){host.dataset.realWaveform=id;}
    else if(waveform!==null&&host.dataset.markup!==waveform){host.innerHTML=waveform;host.dataset.markup=waveform;}
  }
}
