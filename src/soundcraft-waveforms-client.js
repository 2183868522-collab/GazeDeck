import {SoundCraftClientError} from './soundcraft-client.js';

const fail=(code,message)=>new SoundCraftClientError(code,message,false);
const id=value=>Number.isSafeInteger(value)&&value>0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const text=(value,max=4096)=>typeof value==='string'&&value.length<=max;
const sameIds=(a,b)=>a.length===b.length&&[...a].sort((x,y)=>x-y).every((v,i)=>v===[...b].sort((x,y)=>x-y)[i]);

function parse(value,core,ids,bins){
  const invalid=()=>{throw fail('invalid_waveforms_reply','真实波形数据无效；未改变音频控制状态');};
  const all=core?.tracks?.map(track=>track.id)||[];
  if(!value||value.version!==1||value.kind!=='source_envelope_pre_fader'
    ||!text(value.epoch,256)||!value.epoch||value.epoch!==core?.playbackRateEpoch
    ||value.projectKey!==core.projectKey||value.projectPath!==core.projectPath||value.projectName!==core.projectName
    ||!Array.isArray(value.trackIds)||value.trackIds.length>4096||!sameIds(value.trackIds,all)
    ||value.projectKey!==JSON.stringify([value.projectPath,value.projectName,[...all].sort((a,b)=>a-b)])
    ||!finite(value.sampleRate)||value.sampleRate!==core.sampleRate
    ||!Number.isSafeInteger(value.lengthSamples)||value.lengthSamples<0||value.lengthSamples!==core.lengthSamples
    ||value.bins!==bins||!Array.isArray(value.tracks)||value.tracks.length!==ids.length
    ||!sameIds(value.tracks.map(row=>row?.track),ids))invalid();
  for(const row of value.tracks){
    if(!id(row.track)||!text(row.name)||row.name!==core.tracks.find(track=>track.id===row.track)?.name
      ||typeof row.available!=='boolean'||!text(row.reason)||!Array.isArray(row.clips)||row.clips.length>64
      ||!Array.isArray(row.peaks)||row.peaks.length!==bins
      ||row.peaks.some(peak=>peak!==null&&(!Array.isArray(peak)||peak.length!==2||!peak.every(finite)||peak[0]>peak[1]))
      ||!row.available&&row.peaks.some(peak=>peak!==null))invalid();
    const seen=new Set();
    for(const clip of row.clips){
      if(!clip||!id(clip.id)||seen.has(clip.id)||!text(clip.name)||!id(clip.source)
        ||!Number.isSafeInteger(clip.start)||!Number.isSafeInteger(clip.length)||clip.length<0
        ||!Number.isSafeInteger(clip.offset)||!finite(clip.stretch)||clip.stretch<=0
        ||typeof clip.muted!=='boolean'||!Number.isSafeInteger(clip.start+clip.length))invalid();
      seen.add(clip.id);
    }
  }
  return structuredClone(value);
}

// Optional, read-only discovery deliberately does not use core._run: an older
// native application or missing waveform endpoint must not disarm real controls.
export class SoundCraftWaveformsClient{
  constructor(core,{fetchImpl=core.fetchImpl,timeoutMs=5000}={}){
    this.core=core;this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;this.snapshot=null;this.pending=null;this.serial=0;
  }
  cancel({keepSnapshot=false}={}){this.serial++;this.pending?.controller.abort();this.pending=null;if(!keepSnapshot)this.snapshot=null;}
  async read(ids,bins=256){
    if(!Array.isArray(ids)||ids.length<1||ids.length>2||!ids.every(id)||new Set(ids).size!==ids.length
      ||!Number.isInteger(bins)||bins<32||bins>1024)throw fail('invalid_waveforms_query','波形需要 1–2 条不同轨道与 32–1024 个包络列');
    const core=this.core,opening=core.snapshot;
    if(!core.connected||!opening||ids.some(track=>!opening.tracks.some(row=>row.id===track&&row.kind==='audio')))
      throw fail('waveforms_not_connected','请先连接并绑定真实音频轨道');
    if(this.pending)throw fail('waveforms_busy','波形读取正在进行');
    const serial=++this.serial,generation=core._generation,controller=new AbortController();
    const current=()=>serial===this.serial&&core.connected&&core._generation===generation
      &&core.snapshot?.projectKey===opening.projectKey&&core.snapshot?.playbackRateEpoch===opening.playbackRateEpoch
      &&core.snapshot?.lengthSamples===opening.lengthSamples&&core.snapshot?.sampleRate===opening.sampleRate;
    this.pending={controller};let timer;
    try{
      const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fail('waveforms_timeout','波形读取超时；播放与参数控制保持可用'));},this.timeoutMs);});
      const request=(async()=>{
        const response=await this.fetchImpl(`/api/soundcraft/waveforms?tracks=${ids.join(',')}&bins=${bins}`,{signal:controller.signal,cache:'no-store'});
        const body=await response.json();
        if(!current())throw fail('waveforms_changed','连接、工程或目标已变化；未显示旧工程波形');
        if(!response.ok||body?.ok!==true){
          const code=body?.error?.code;
          throw fail(['not_found','waveforms_unsupported'].includes(code)?'waveforms_unsupported':text(code,128)?code:'waveforms_error',
            ['not_found','waveforms_unsupported'].includes(code)?'波形接口尚未加载，请重启桌面 serve.py 与新版 SoundCraft；其他控制仍可使用':text(body?.error?.message)?body.error.message:'无法读取真实波形');
        }
        return parse(body.result,opening,ids,bins);
      })();
      const value=await Promise.race([request,timeout]);
      if(!current())throw fail('waveforms_changed','连接或工程已变化；未显示旧工程波形');
      this.snapshot=value;return value;
    }catch(error){
      if(serial===this.serial)this.snapshot=null;
      if(error instanceof SoundCraftClientError)throw error;
      throw fail('waveforms_error','无法读取波形；未改变播放或音量，请检查连接后刷新波形');
    }finally{clearTimeout(timer);if(serial===this.serial)this.pending=null;}
  }
}
