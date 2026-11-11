// Read-only source envelopes. Marker updates never replace the static SVG paths.
const WIDTH=1000, HEIGHT=88, TOP=22, BOTTOM=66, CENTER=(TOP+BOTTOM)/2;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positiveInteger=value=>Number.isSafeInteger(value)&&value>0;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const number=value=>Number(value.toFixed(3));
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const short=value=>{const chars=Array.from(String(value??''));return chars.length>24?chars.slice(0,23).join('')+'…':chars.join('');};
const clock=samples=>{const seconds=Math.max(0,Math.floor(samples));return`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const x=(samples,length)=>number(clamp(samples/length,0,1)*WIDTH);
const y=amplitude=>number(CENTER-clamp(amplitude,-1,1)*(BOTTOM-TOP)/2);
const reasons={
  'No audio clips on the active playlist':'当前轨道没有音频片段',
  'Waveform overview supports at most 64 clips per track':'该轨道片段过多，暂不显示波形',
  'Clip metadata, timing or source type is unsupported':'片段类型或时间信息暂不支持显示',
  'Active playlist contains a non-audio clip':'当前播放列表包含非音频片段',
  'Audio source is not loaded':'音频素材未载入，请在 SoundCraft 中检查素材',
  'Decoded audio sample rate differs from the session':'素材采样率与工程不一致，暂不显示波形',
  'Decoded source channels or waveform peaks are unavailable':'素材声道或波形数据不可用',
  'Decoded waveform peaks do not match the loaded source':'波形数据与素材不一致，请刷新',
  'Waveform query is too complex':'素材内容过于复杂，暂不显示波形',
  'Waveform query exceeds the bounded clip/channel budget':'片段与声道数量过多，暂不显示波形',
  'Source timing cannot be represented':'素材时间范围无法显示',
  'Decoded waveform contains non-finite peaks':'素材波形包含无效数值',
};

function validPeaks(peaks){
  return Array.isArray(peaks)&&peaks.length>=32&&peaks.length<=1024&&peaks.every(peak=>peak===null
    ||Array.isArray(peak)&&peak.length===2&&peak.every(finite)&&peak[0]<=peak[1]);
}
function validClip(clip){
  return clip&&Number.isSafeInteger(clip.id)&&clip.id>0&&typeof clip.name==='string'
    &&Number.isSafeInteger(clip.start)&&Number.isSafeInteger(clip.length)&&clip.length>=0
    &&Number.isSafeInteger(clip.start+clip.length)&&typeof clip.muted==='boolean';
}
function marker(position,length,kind,color,label,verified=true){
  const visible=verified&&finite(position)&&position>=0&&position<=length;
  const at=visible?x(position,length):0;
  return`<g data-waveform-marker="${kind}"${visible?'':' visibility="hidden"'} transform="translate(${at} 0)" style="pointer-events:none"><title>${label}</title><line x1="0" x2="0" y1="17" y2="${BOTTOM+1}" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="M -5 15 L 5 15 L 0 21 Z" fill="${color}"/></g>`;
}

/**
 * `track.peaks` is a uniform min/max envelope over the complete project timeline.
 * Gaps are null; [0,0] is real digital silence. All amplitudes are pre-processing.
 * Independent sourcePositionSamples must be verified against the current rate read.
 */
export function waveformMarkup(track,{deck='A',sampleRate,lengthSamples,positionSamples=null,sourcePositionSamples=null,sourcePositionVerified=false}={}){
  const safeDeck=deck==='B'?'B':'A',color=safeDeck==='B'?'#9d62bf':'#239d90';
  const trackId=Number.isSafeInteger(track?.track)&&track.track>0?track.track:null;
  const ready=track?.available===true&&trackId!==null&&positiveInteger(sampleRate)&&positiveInteger(lengthSamples)&&validPeaks(track.peaks);
  const base=`class="sc-waveform" data-waveform-track="${trackId??''}" data-waveform-length="${positiveInteger(lengthSamples)?lengthSamples:0}" data-waveform-sample-rate="${positiveInteger(sampleRate)?sampleRate:0}" data-waveform-deck="${safeDeck}"`;
  if(!ready){
    const reason=track?.available===false&&typeof track.reason==='string'&&track.reason?track.reason
      :!positiveInteger(lengthSamples)?'工程尚无可显示时长':'素材波形尚未读取';
    return`<div ${base}><p class="sc-waveform-unavailable" role="status">${escape(Object.hasOwn(reasons,reason)?reasons[reason]:reason)}</p></div>`;
  }
  const clips=Array.isArray(track.clips)?track.clips.filter(validClip):[];
  const path=track.peaks.map((peak,index)=>{
    if(peak===null)return'';
    const at=number((index+.5)*WIDTH/track.peaks.length);
    return`M${at} ${y(peak[1])}V${y(peak[0])}`;
  }).filter(Boolean).join('');
  const clipRegions=clips.map(clip=>{
    const left=x(clip.start,lengthSamples),right=x(Math.min(lengthSamples,clip.start+clip.length),lengthSamples);
    if(right<=left)return'';
    const label=`${clip.name||'未命名片段'}${clip.muted?'（静音）':''}`;
    const full=`${label} · ${clock(clip.start/sampleRate)}–${clock((clip.start+clip.length)/sampleRate)}`;
    // Each clip has its own bounded viewport so adjacent labels cannot overflow.
    return`<svg x="${left}" y="0" width="${number(right-left)}" height="${HEIGHT}" overflow="hidden" aria-label="${escape(full)}"><title>${escape(full)}</title><rect x="0" y="2" width="100%" height="66" fill="${color}" fill-opacity="${clip.muted?'.035':'.07'}"/><line x1="0" x2="0" y1="2" y2="68" stroke="${color}" stroke-opacity=".4" vector-effect="non-scaling-stroke"/><text x="4" y="12" fill="${color}" font-size="10">${escape(short(label))}</text></svg>`;
  }).join('');
  const duration=lengthSamples/sampleRate;
  const amplitudeClipped=track.peaks.some(peak=>peak!==null&&(peak[0]<-1||peak[1]>1));
  const ticks=[0,.25,.5,.75,1].map(fraction=>{
    const at=number(fraction*WIDTH),anchor=fraction===0?'start':fraction===1?'end':'middle';
    return`<line x1="${at}" x2="${at}" y1="18" y2="68" stroke="#8e9baa" stroke-opacity=".18" vector-effect="non-scaling-stroke"/><text x="${at}" y="82" text-anchor="${anchor}" fill="#667384" font-size="10">${clock(duration*fraction)}</text>`;
  }).join('');
  const clipNames=clips.length?clips.map(clip=>`${clip.name||'未命名片段'}${clip.muted?'（静音）':''}`).join(' · '):'没有音频片段';
  return`<div ${base}><div class="sc-waveform-summary" style="display:flex;gap:8px;align-items:baseline;font-size:10px;text-align:left;min-width:0"><strong title="${escape(clipNames)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1">${escape(clipNames)}</strong><span style="white-space:nowrap;color:#667384">素材包络</span></div>
    <svg class="sc-waveform-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="none" role="img" aria-label="Deck ${safeDeck} 原始素材包络，工程时间轴 ${escape(clock(duration))}" style="display:block;width:100%;height:70px;overflow:hidden;background:#f6f9fc;border-radius:4px">
      <title>原始素材包络：前推子、前片段增益、前淡入淡出、前 EQ 与效果器；不表示实际输出响度${amplitudeClipped?'；超出 ±1 的峰值仅在图形边缘裁切，未重新归一化':''}</title>
      ${clipRegions}${ticks}<line x1="0" x2="${WIDTH}" y1="${CENTER}" y2="${CENTER}" stroke="${color}" stroke-opacity=".25" vector-effect="non-scaling-stroke"/>
      <path data-waveform-envelope="" d="${path}" fill="none" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${marker(positionSamples,lengthSamples,'project','#d97d24','工程播放头')}${marker(sourcePositionSamples,lengthSamples,'source','#2076bf','独立素材位置',sourcePositionVerified===true)}
    </svg><div class="sc-waveform-position" style="font-size:10px;text-align:left;color:#667384"><span data-waveform-project-time></span><span data-waveform-source-time></span></div></div>`;
}

/**
 * `trackPositions` is [{track,sourcePositionSamples,sourcePositionVerified}].
 * Only current, explicitly verified independent source positions may be displayed.
 */
export function updateWaveformMarkers(root,{positionSamples=null,lengthSamples,trackPositions=[]}={}){
  const tracks=Array.isArray(trackPositions)?trackPositions:[];
  for(const host of root.querySelectorAll('[data-waveform-track]')){
    const ownLength=Number(host.dataset.waveformLength),sampleRate=Number(host.dataset.waveformSampleRate),track=Number(host.dataset.waveformTrack);
    const current=positiveInteger(ownLength)&&ownLength===lengthSamples&&positiveInteger(sampleRate);
    const rows=tracks.filter(row=>row?.track===track),row=rows.length===1?rows[0]:null;
    const projectVisible=current&&finite(positionSamples)&&positionSamples>=0&&positionSamples<=ownLength;
    const source=row?.sourcePositionSamples,sourceVisible=current&&row?.sourcePositionVerified===true&&finite(source)&&source>=0&&source<=ownLength;
    for(const [kind,position,visible]of[['project',positionSamples,projectVisible],['source',source,sourceVisible]]){
      const element=host.querySelector(`[data-waveform-marker="${kind}"]`);
      if(!element)continue;
      element.setAttribute('visibility',visible?'visible':'hidden');
      if(visible)element.setAttribute('transform',`translate(${x(position,ownLength)} 0)`);
    }
    const projectText=host.querySelector('[data-waveform-project-time]'),sourceText=host.querySelector('[data-waveform-source-time]');
    if(projectText)projectText.textContent=projectVisible?`工程 ${clock(positionSamples/sampleRate)}`:'工程位置待回读';
    if(sourceText)sourceText.textContent=sourceVisible?` · 独立素材 ${clock(source/sampleRate)}`:'';
  }
}
