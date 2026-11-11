import { SoundCraftPresetStore, presetTargets } from './soundcraft-preset-store.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const labels = {reverb:'混响',delay:'延迟',chorus:'合唱'};
export function toneDescription(tone) {
  if (!tone) return '待读取';
  const eq = tone.eq;
  return `EQ ${eq.enabled ? '开启' : '关闭'}：Low ${eq.low.toFixed(1)} / Mid ${eq.mid.toFixed(1)} / High ${eq.high.toFixed(1)} dB；`
    + Object.entries(labels).map(([key,label]) => `${label} ${tone.effects[key].enabled ? '开启' : '关闭'} ${(tone.effects[key].amount*100).toFixed(1)}%`).join(' · ');
}

// Local selection/save never writes engine parameters. Apply submits one native
// transaction after the user has seen the per-track before/after preview.
export function mountSoundCraftPresets(root, {client, tones, environment, eyesEnabled, onResult, onState, onError,
  store = new SoundCraftPresetStore(), now = () => performance.now()}) {
  let session = null, generation = 0, selected = null, storageError = '', lastFace = -Infinity;
  const q = id => root.querySelector(`#${id}`);
  try { store.load(); } catch (error) { storageError = error.message; }
  const entries = () => store.list();
  function summary() {
    const records = entries(), record = records.find(item => item.id === selected) || null;
    return {count:records.length, selected:record, storageError};
  }
  root.innerHTML = `<div class="sc-volume-card" style="max-height:90vh;overflow:auto">
    <span class="eyebrow">SoundCraft · 音色预设 · 仅音色参数</span><h2 id="scPresetTitle"></h2>
    <p id="scPresetScope" class="muted"></p><p id="scPresetStatus" role="status" aria-live="polite"></p>
    <label id="scPresetNameLabel">新预设名称 <input id="scPresetName" maxlength="60" aria-label="新音色预设名称（最多60字）"></label>
    <ol id="scPresetList" class="deck-track-options"></ol>
    <div id="scPresetPreview" style="font-size:14px;line-height:1.55"></div>
    <p id="scPresetInstructions"></p>
    <div class="row sc-live-actions"><button id="scPresetPrevious">左看 · 上一个</button><button id="scPresetNext">右看 · 下一个</button>
      <button id="scPresetCancel">上看 · 取消</button><button id="scPresetConfirm" class="primary">下看 · 确认</button>
      <button id="scPresetObserve">进入观察模式</button></div>
    <p class="muted">保存和预览不改变声音。确认应用时只改变 EQ 三段增益与开关、混响／延迟／合唱的开关与干湿比例；保留其他插件、EQ 频率、效果器其他参数、音量、倍率、循环和播放进度。音色预设保存在当前浏览器中，工程音色需另在 SoundCraft 保存。</p>
  </div>`;
  function report(gesture, message, executed, source = '手动控制') {
    onResult?.(gesture,{executed,message,from:'音色预设',to:'音色预设'},source);
  }
  function issue(s) {
    if (!client.connected || client.snapshot?.projectKey !== s.snapshot.projectKey
      || client.snapshot?.playbackRateEpoch !== s.snapshot.epoch || client._generation !== s.coreGeneration)
      return '连接或工程会话已变化，请关闭后重新读取，未自动发送修改';
    return '';
  }
  function close(result = {}) {
    session = null; generation++; root.classList.toggle('hidden',true);
    onState?.(false,{...result,summary:summary()});
  }
  function preview(s) {
    if (s.kind === 'select') return '';
    return s.ids.map(({deck,track}) => {
      const row = s.snapshot.tracks.find(item => item.track === track);
      const before = row?.tone;
      const requested = s.targets?.find(item => item.track === track)?.tone;
      const after=requested?structuredClone(requested):null;
      if(after&&Array.isArray(row.inserts)) {
        if(!after.eq.enabled&&!row.inserts.some(item=>item.plugin==='eq_7band'))after.eq=structuredClone(before.eq);
        for(const [key,plugin]of Object.entries({reverb:'room_reverb',delay:'mod_delay',chorus:'chorus'}))
          if(!after.effects[key].enabled&&!row.inserts.some(item=>item.plugin===plugin))after.effects[key]=structuredClone(before.effects[key]);
      }
      return `<section><b>Deck ${escape(deck)} · ID ${track}</b><p>${s.kind==='save'?'保存内容':'当前'}：${escape(toneDescription(before))}</p>${after?`<p>应用后：${escape(toneDescription(after))}</p>`:''}</section>`;
    }).join('');
  }
  function render() {
    const s = session; if (!s) return;
    const records = entries(), record = records[s.index];
    q('scPresetTitle').textContent = s.kind==='save'?'保存当前音色为新预设':s.kind==='select'?'选择音色预设':`预览并应用：${s.record.name}`;
    q('scPresetScope').textContent = `作用对象：Deck ${s.scope}${s.kind==='save'&&s.scope==='AB'?' · 分别保存 A/B 两套数值':''}`;
    q('scPresetStatus').textContent = s.observing?'观察模式：长眨恢复；未发送修改':s.status;
    q('scPresetNameLabel').classList.toggle('hidden',s.kind!=='save');
    if (q('scPresetName').value !== s.name) q('scPresetName').value=s.name;
    q('scPresetName').disabled=s.finishing||s.observing;
    q('scPresetList').classList.toggle('hidden',s.kind!=='select');
    q('scPresetList').innerHTML = s.kind==='select'?records.slice(Math.max(0,s.index-2),Math.max(0,s.index-2)+5).map(item=>`<li class="${item.id===record?.id?'selected':''}">${escape(item.name)} · ${item.mode==='pair'?'AB 双轨预设':'单轨通用预设'}</li>`).join(''):'';
    q('scPresetPreview').innerHTML=preview(s);
    q('scPresetInstructions').textContent=s.kind==='select'?'左右选择候选；下看选定但不应用；上看或双眨取消。':s.kind==='save'?'下看保存新预设；可手动命名，也可保留自动名称；上看或双眨取消，不影响已有预设。':'下看一次性应用所列音色；上看或双眨取消，声音保持原样。预览只显示数值，不试听、不改音频。';
    for (const id of ['scPresetPrevious','scPresetNext']) {q(id).classList.toggle('hidden',s.kind!=='select');q(id).disabled=s.finishing||s.observing||!records.length;}
    q('scPresetCancel').disabled=s.finishing;
    q('scPresetConfirm').disabled=s.finishing||s.observing||s.failed||(s.kind==='select'&&!records.length);
    q('scPresetObserve').disabled=s.finishing;q('scPresetObserve').textContent=s.observing?'退出观察模式':'进入观察模式';
  }
  async function confirm(source) {
    const s=session; if(!s || s.finishing || s.observing || s.failed)return;
    const error=issue(s); if(error){s.status=error;render();return;}
    if(s.kind==='select') {
      const record=entries()[s.index];if(!record)return;
      selected=record.id; report('下看',`已选择「${record.name}」，尚未应用到音频`,true,source);close();return;
    }
    if(s.kind==='save') {
      try {
        const captured=Object.fromEntries(s.ids.map(({deck,track})=>[deck,s.snapshot.tracks.find(item=>item.track===track).tone]));
        const record=store.save({name:s.name,mode:s.scope==='AB'?'pair':'single',tones:s.scope==='AB'?captured:{A:captured[s.scope]}});
        selected=record.id;storageError='';report('下看',`已保存「${record.name}」；音频及已有预设保持不变`,true,source);close();
      } catch(error) {s.status=`保存失败：${error.message}；未覆盖已有预设，可修改名称后重试`;report('下看',s.status,false,source);render();}
      return;
    }
    s.finishing=true;s.status='正在一次性应用并等待原生引擎回读…';render();const ticket=generation;
    try {
      const result=await tones.apply(s.targets,s.snapshot);
      if(ticket!==generation || session!==s)return;
      if(!result || typeof result.changed!=='boolean')throw new Error('未取得完整应用回执，请重新连接核对');
      report('下看',result.changed?`已应用「${s.record.name}」至 Deck ${s.scope}；播放进度保持`:'音色已与预设相同，未重复修改',true,source);
      close({committed:result.changed,result});
    } catch(error) {
      if(ticket!==generation || session!==s)return;
      s.finishing=false;s.failed=true;s.status=`${error.message}；请关闭并重新连接核对，未重发`;
      report('下看',s.status,false,source);onError?.(error);render();
    }
  }
  function gesture(gesture,source='手动控制',note='') {
    const s=session;if(!s)return;
    if(s.finishing)return;
    if(gesture==='双眨'||gesture==='上看'){report(gesture,note+(s.failed?'已关闭；此前提交失败或结果未确认，请重新连接核对，未重发':'已取消本次预设操作，未发送音色修改'),true,source);close();return;}
    if(source==='眼动识别'&&(!eyesEnabled?.()||!environment().camera||!environment().baseline||now()-lastFace>750)) {
      s.status='当前人脸或静息校准未就绪，未执行预设操作';report(gesture,s.status,false,source);render();return;
    }
    if(gesture==='长眨'){s.observing=!s.observing;report(gesture,s.observing?'进入预设观察模式':'恢复预设操作',true,source);render();return;}
    if(s.observing)return;
    if(gesture==='下看'){void confirm(source);return;}
    if(s.kind==='select'&&['左看','右看'].includes(gesture)&&entries().length) {
      s.index=(s.index+(gesture==='左看'?-1:1)+entries().length)%entries().length;
      report(gesture,`候选「${entries()[s.index].name}」，尚未选定或应用`,true,source);render();
    }
  }
  root.onclick=event=>{const button=event.target.closest('button');if(!button||button.disabled)return;
    const gestureName={scPresetPrevious:'左看',scPresetNext:'右看',scPresetCancel:'上看',scPresetConfirm:'下看',scPresetObserve:'长眨'}[button.id];
    if(gestureName){event.stopPropagation?.();gesture(gestureName);}};
  root.oninput=event=>{if(session?.kind==='save'&&event.target.id==='scPresetName')session.name=event.target.value;};
  root.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();gesture('双眨');}});
  return {
    isOpen:()=>!!session, summary,
    open(kind,{scope,ids,snapshot}) {
      if(session || !['save','select','apply'].includes(kind))throw new Error('请先完成当前预设弹窗');
      if(storageError)throw new Error(`音色预设存储不可用：${storageError}；不会覆盖原有内容`);
      const record=entries().find(item=>item.id===selected);
      if(kind==='apply'&&!record)throw new Error('请先下看选择一个预设');
      const targets=kind==='apply'?presetTargets(record,scope,Object.fromEntries(ids.map(item=>[item.deck,item.track]))):null;
      for(const {track}of ids) {const row=snapshot?.tracks.find(item=>item.track===track);if(!row?.available)throw new Error(row?.reason||'所选轨道音色不可读取');}
      session={kind,scope,ids,snapshot:structuredClone(snapshot),coreGeneration:client._generation,record,targets,index:Math.max(0,entries().findIndex(item=>item.id===selected)),
        name:`音色预设 ${new Date().toLocaleString()}`,status:kind==='select'?`${entries().length} 个预设；选定不会立即应用`:'已读取当前真实音色；等待确认',observing:false,finishing:false,openedAt:now()};
      generation++;root.classList.toggle('hidden',false);render();onState?.(true,{summary:summary()});
      if(kind==='save')q('scPresetName').focus?.();else q('scPresetConfirm').focus?.();
    },
    gesture,
    frame(raw){lastFace=raw?now():-Infinity;},
    tick(){const s=session;if(s&&!s.finishing&&(now()-s.openedAt>120000||issue(s))){report('预设状态',s.failed?'已关闭；此前提交失败或结果未确认，请重新连接核对，未重发':'弹窗已取消（超时或会话变化），未发送修改',false);close();}},
    detach(){if(session)close();},
  };
}
