import {dayWindow, decodeIndex, atTime} from './timeline.js';

/** 页面导航与录像服务解耦；设置控件复用既有校验、草稿与保存流程。 */
export function installHostUI(core) {
  const {state, el, api, toast, mediaUrl, bytesText, dateText, downloadLink} = core;
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  let selectedLog=null;
  let route = 'home', channel = 1, detail = false, archive = false, sequence = 0, eventSequence = 0, scrollTimer;
  let day, index = {recordings:[],events:[]}, selectedTime = 0, currentClip = null, precise = false;
  const names = {home:'设备设置',channels:'通道管理',device:'设备信息',service:'本地服务',storage:'录像存储',model:'识别模型',logs:'日志与诊断',logDetail:'日志详情',licenses:'第三方组件与许可',appearance:'外观与显示',about:'关于 AiRec',channel:'通道设置',basic:'通道信息',image:'图像设置',recording:'录像设置',detection:'智能侦测',categories:'识别类别',dwell:'停留检测',confidence:'识别置信度',advanced:'高级参数'};
  const parents = {logDetail:"logs",licenses:"about",basic:'channel',image:'channel',recording:'channel',detection:'channel',categories:'detection',dwell:'detection',confidence:'detection',advanced:'detection',channel:'channels'};
  const channelRoutes = ['channel','basic','image','recording','detection','categories','dwell','confidence','advanced'];
  const button = (text, action, style='secondary') => { const b=el('button','button '+style,text);b.type='button';b.onclick=action;return b; };
  const row = (label, value='', action=null, hint='') => {
    const r=el(action?'button':'div','option-row'); if(action){r.type='button';r.onclick=action;}
    const left=el('span','option-label',label);if(hint)left.append(el('small','',hint));
    r.append(left,el('span','option-value',value));if(action)r.append(el('span','chevron','›'));return r;
  };
  const group = (...children) => {const g=el('section','option-group');g.append(...children);return g;};
  const note = text => el('p','footnote',text);
  function choiceDialog(select, title) {
    const dialog=el('dialog','choice-dialog'),options=group();let chosen=select.value;
    dialog.append(el('h2','',title));
    Array.from(select.options).forEach(option=>{const r=row(option.text,'',()=>{chosen=option.value;Array.from(options.querySelectorAll('input')).forEach(n=>n.checked=n.value===chosen);});const radio=el('input');radio.type='radio';radio.name='host-choice';radio.value=option.value;radio.checked=chosen===option.value;r.append(radio);options.append(r);});
    const actions=el('div','dialog-actions');actions.append(button('取消',()=>dialog.close()),button('确定',()=>{select.value=chosen;select.dispatchEvent(new Event('change',{bubbles:true}));dialog.close();},'primary'));
    dialog.append(options,actions);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  }
  function confirmStop() {
    const dialog=el('dialog','stop-dialog');dialog.append(el('h2','','停止录像？'),note('当前片段会先保存，再停止采集、识别和局域网服务。已有录像和设置保留。'));
    const actions=el('div','dialog-actions');actions.append(button('继续录像',()=>dialog.close()),button('停止录像',()=>{dialog.close();HostControl.stop();},'primary'));dialog.append(actions);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
  }
  let exportBackground=false;
  function exportState(data) {
    if(data.phase==='running'&&data.received===0&&data.total===-1)exportBackground=false;
    let dialog=$('#host-export');if(!dialog){dialog=el('dialog');dialog.id='host-export';dialog.onclose=()=>{exportBackground=true;};document.body.append(dialog);}
    dialog.replaceChildren(el('h2','',data.label||'导出文件'),note(data.phase==='done'?'文件已导出':data.phase==='failed'?'导出失败':'正在导出文件'));
    if(data.phase==='running'){const progress=el('progress');progress.max=data.total>0?data.total:1;if(data.total>0)progress.value=data.received;dialog.append(progress,note(bytesText(data.received)+(data.total>0?' / '+bytesText(data.total):'')));}
    if(data.message)dialog.append(note(data.message));const actions=el('div','dialog-actions');actions.append(button(data.phase==='running'?'后台继续':'关闭',()=>dialog.close()));dialog.append(actions);if(!dialog.open&&!exportBackground)dialog.showModal();
  }
  function go(name) { route=name;core.setPage('settings');renderRoute(); }
  function showTheme(mode) {
    if(!['light','dark','system'].includes(mode))mode='light';
    try{localStorage.setItem('airec-theme',mode);}catch(e){}
    const dark=mode==='dark'||(mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark',dark);
    if(window.HostControl)HostControl.theme(dark);
  }
  let theme='light';try{theme=localStorage.getItem('airec-theme')||'light';}catch(e){}showTheme(theme);
  const preference=matchMedia('(prefers-color-scheme: dark)');preference.addListener(()=>{if(theme==='system')showTheme(theme);});

  // 主机与局域网网页共用同一套页面；原生服务按钮仅在本机显示。
  const brand=$('.brand');brand.querySelector('span:last-child').textContent='AiRec';
  const top=$('.topbar');top.querySelector('.breadcrumb').textContent='AiRec · 录像主机';
  const pageLabel=el('span','sr-only');pageLabel.id='page-label';top.append(pageLabel);
  const icons = [
    '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
    '<path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 21h4"/>',
    '<circle cx="12" cy="12" r="4"/><path d="m9 3 6 0 1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/>'];
  $$('.nav-button').forEach((b,i)=>{b.lastChild.textContent=['实时','回放','事件','设置'][i];b.querySelector('svg').innerHTML=icons[i];});
  const smallFeeds=el('div','small-feeds');Array.from(state.cards.values()).slice(1).forEach(card=>smallFeeds.append(card.node));$('#camera-grid').append(smallFeeds);
  state.cards.forEach(card=>{const placeholder=card.placeholder.querySelector('.placeholder-icon');placeholder.innerHTML='<svg viewBox="0 0 24 24"><path d="m3 3 18 18M6 6H4v12h12v-2m0-6V6h-5m5 5 5-3v9l-3-2"/></svg>';});
  $('.stats-grid').hidden=true;
  const live=$('#page-live'), heading=$('.section-heading');
  const title=el('div');title.append(el('h2','','实时预览'));const subtitle=el('p','muted');subtitle.id='live-summary';title.append(subtitle);
  // 原刷新按钮仍保留事件处理器。
  const reconnect=$('#reconnect-streams');
  heading.replaceChildren(title,button('查看设备',()=>go('device')));if(reconnect)heading.append(reconnect);
  live.prepend(heading);
  Array.from(live.children).filter(n=>n.classList.contains('footnote')).forEach(n=>n.remove());
  const system=$('.system-panel');live.append(system);
  const serviceState=el('div','service-empty');serviceState.hidden=true;live.append(serviceState);
  const statusFoot=el('p','footnote','无信号通道独立等待，其他通道继续录像。');live.append(statusFoot);
  const settings=$('#page-settings'), menu=el('div','settings-menu'), subhead=el('div','workspace-head');
  const back=button('‹',()=>backPage());back.setAttribute('aria-label','返回');
  const titleNode=el('h2','','设备设置');subhead.append(back,titleNode);settings.prepend(subhead,menu);
  const systemClone=el('div');systemClone.id='device-details';settings.append(systemClone);
  const channelMenu=el('div');channelMenu.id='channel-menu';$('#settings-form').prepend(channelMenu);
  $('.device-note').hidden=true;
  $('#storage-target').onmousedown=e=>{e.preventDefault();choiceDialog(e.currentTarget,'保存介质');};
  $('#storage-target').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choiceDialog(e.currentTarget,'保存介质');}};
  const storageCard=$('.storage-settings'), storageGrid=el('div','storage-columns');
  const storageLeft=group($('#storage-target').closest('label'));
  const totalStorage=row('总容量','—'),freeStorage=row('当前可用','—');storageLeft.append(totalStorage,freeStorage);
  const storageRight=group($('#storage-max-gb').closest('label'),$('#storage-min-free-gb').closest('label'),row('空间不足时','自动删除最旧录像与事件'));
  const storageUsage=el('progress','storage-progress');storageUsage.max=100;
  const leftColumn=el('div');leftColumn.append(storageLeft,storageUsage,$('#refresh-storage-targets'));
  const rightColumn=el('div');rightColumn.append(storageRight,note('循环清理仅针对本应用保存的文件。外置存储需要可写后才能选择。'));
  const targetInfo=$('#storage-target-info');targetInfo.hidden=true;
  storageGrid.append(leftColumn,rightColumn);storageCard.replaceChildren(storageGrid,targetInfo);

  ['recordings','events'].forEach(name=>$('#page-'+name).prepend(el('h2','list-title',name==='recordings'?'录像回放':'智能事件')));

  const typeSelect=$('#event-type-filter');typeSelect.parentElement.hidden=true;
  const eventChips=el('div','chips');['','dwell','person','vehicle','animal'].forEach((value,i)=>{const b=button(['全部','长时间停留','人','车','动物'][i],()=>{typeSelect.value=value;typeSelect.dispatchEvent(new Event('change'));Array.from(eventChips.children).forEach(c=>c.classList.toggle('selected',c===b));});if(!i)b.classList.add('selected');eventChips.append(b);});$('#events-grid').before(eventChips);
  ['recordings','events'].forEach(name=>{
    const page=$('#page-'+name),title=page.querySelector('.list-title'),toolbar=page.querySelector('.toolbar'),head=el('div','history-head');
    toolbar.querySelectorAll('label').forEach(label=>Array.from(label.childNodes).forEach(n=>{if(n.nodeType===3)n.textContent='';}));
    page.prepend(head);head.append(title,toolbar);
  });
  function configureCards() {
    $$('#channel-settings>.settings-card').forEach(card=>{
      if(card.dataset.grouped)return;card.dataset.grouped='1';
      const fields=Array.from(card.querySelectorAll('[data-key]'));
      const panels={};['basic','image','recording','detection','categories','dwell','confidence','advanced','channel'].forEach(key=>{const panel=el('div','field-panel');panel.dataset.panel=key;panels[key]=panel;});
      const map={name:'basic',source:'basic',crop:'basic',width:'image',height:'image',preview_fps:'image',fps:'recording','recording.enabled':'recording','recording.segment_minutes':'recording',enabled:'channel','detection.enabled':'detection','detection.threshold_seconds':'dwell','detection.confidence':'confidence','detection.sample_interval':'advanced','detection.lost_tolerance_seconds':'advanced'};
      fields.forEach(input=>{const key=input.dataset.key;const label=input.closest('label');if(label)panels[key.startsWith('category.')?'categories':map[key]].append(label);});
      card.replaceChildren(...Object.values(panels));
      const segment=card.querySelector('[data-key="recording.segment_minutes"]');segment.onmousedown=e=>{e.preventDefault();choiceDialog(segment,'录像片段时长');};segment.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();choiceDialog(segment,'录像片段时长');}};
      panels.basic.append(note('视频来源与画面区域决定接线映射，请按实际板卡配置。'));
      panels.dwell.prepend(row('检测对象','人、动物'));
      panels.dwell.append(note('仅人和动物参与停留检测，车辆不计停留时间。'));
      panels.recording.append(row('视频编码','H.264'),note('实际帧率受采集和编码负载影响。'));
    });
    renderRoute();
  }
  function renderRoute() {
    if(state.page!=='settings')return;
    if(route==='storage'){const st=state.status&&state.status.storage||{};totalStorage.querySelector('.option-value').textContent=bytesText(st.total_bytes);freeStorage.querySelector('.option-value').textContent=bytesText(st.free_bytes);storageUsage.value=st.total_bytes?100*(1-st.free_bytes/st.total_bytes):0;}
    $('#settings-form').className='route-'+route;
    menu.dataset.route=route;
    titleNode.textContent=names[route];back.hidden=route==='home';
    menu.replaceChildren();channelMenu.replaceChildren();systemClone.replaceChildren();
    $('.model-settings').hidden=true;$('.diagnostics-settings').hidden=true;
    $('#settings-form').hidden=!(route==='storage'||channelRoutes.includes(route));
    $('.storage-settings').hidden=route!=='storage';
    $$('#channel-settings>.settings-card').forEach(card=>{
      card.hidden=!channelRoutes.includes(route)||Number(card.dataset.channelId)!==channel;
      Array.from(card.querySelectorAll('[data-panel]')).forEach(p=>p.hidden=p.dataset.panel!==route);
    });
    $('.save-bar').hidden=!(route==='storage'||channelRoutes.includes(route));
    if(route==='home') {
      menu.className='settings-menu two-columns home-menu';
      menu.append(group(row('录像主机','RK3399PRO',()=>go('device'),'设备信息、运行状态'),row('本地服务',state.connected?'运行中':'未连接',()=>go('service'),'启动、停止与开机恢复')),
        group(row('录像存储',state.status&&state.status.storage&&state.status.storage.label||'保存介质',()=>go('storage'),'保存介质与循环录像'),row('通道管理','5 路',()=>go('channels'),'图像、录像与智能侦测')),
        group(row('识别模型','YOLOv5s',()=>go('model'),'NPU 推理与目标跟踪'),row('日志与诊断','',()=>go('logs'),'查看与导出日志')),
        group(row('外观与显示',{light:'浅色',dark:'深色',system:'跟随系统'}[theme],()=>go('appearance')),row('关于 AiRec','安卓录像主机',()=>go('about'))));
    } else {
      menu.className='settings-menu form-width';
      if(route==='channels')menu.append(group(...[1,2,3,4,5].map(id=>row('AHD'+id,'图像、录像与侦测',()=>{channel=id;go('channel');}))));
      if(route==='channel') {
        const original=$('[data-channel-id="'+channel+'"] [data-key=enabled]');
        const enabledRow=row('启用通道'),toggle=el('input');toggle.type='checkbox';toggle.checked=original.checked;
        toggle.onchange=()=>{original.checked=toggle.checked;original.dispatchEvent(new Event('change',{bubbles:true}));};enabledRow.append(toggle);
        channelMenu.append(group(row('通道信息','AHD'+channel,()=>go('basic')),enabledRow,row('图像设置','分辨率与预览',()=>go('image')),row('智能侦测','类别与停留阈值',()=>go('detection'))),
          group(row('录像设置','连续录像与分段',()=>go('recording')),row('应用到其他通道','保留目标通道名称与接线',()=>core.openCopyDialog(channel))));
      }
      if(route==='detection')channelMenu.append(group(row('识别类别','人、车、动物',()=>go('categories')),row('停留检测','仅人、动物',()=>go('dwell')),row('识别置信度','',()=>go('confidence')),row('高级参数','检测间隔、消失容忍',()=>go('advanced'))));
      if(route==='device')renderDevice();
      if(route==='model')renderModel();
      if(route==='logs')renderLogs();
      if(route==='logDetail')menu.append(group(row('文件名',selectedLog.name),row('大小',bytesText(selectedLog.size_bytes)),row('最后更新',dateText(selectedLog.modified_at))),note('导出诊断包后可在电脑上查看完整日志。'),downloadLink('/api/logs/download','导出诊断包'));
      if(route==='appearance')menu.append(group(...['system','light','dark'].map(m=>row({system:'跟随系统',light:'浅色',dark:'深色'}[m],m===theme?'✓':'',()=>{theme=m;showTheme(m);renderRoute();}))),note('仅改变当前界面，不影响录像与客户端主题。'),themePreview());
      if(route==='about')menu.append(group(row('AiRec','安卓录像主机'),row('版本','1.0.0'),row('适配系统','Android 9 及以上'),row('运行平台','ARM64 · RK3399PRO'),row('第三方组件与许可','',()=>go('licenses'))));
      if(route==='licenses') {
        menu.append(group(row('AiRec','安卓录像主机'),row('版本','1.0.0'),row('系统要求','Android 9 / ARM64')));
        const licenses=group();['Project-GPL-3.0.txt','YOLOv5-GPL-3.0.txt','ByteTrack-MIT.txt','RK3399Pro_npu-Apache-2.0.txt','Android-NDK-NOTICE.txt'].forEach(name=>licenses.append(row(name,'查看许可',async()=>{try{const response=await fetch('/static/licenses/'+name);if(!response.ok)throw Error('读取许可失败');const text=await response.text();$('#media-title').textContent=name;$('#media-content').replaceChildren(el('pre','license-text',text));$('#media-note').textContent='';$('#media-dialog').showModal();}catch(e){toast(e.message);}})));menu.append(licenses);
      }
      if(route==='service')renderService();
    }
  }
  function themePreview(){const box=el('div','theme-previews');['浅色','深色'].forEach(t=>{const p=el('div','',t);p.append(el('i'),el('i'));box.append(p);});return box;}
  function renderModel(){
    const m=state.model||{};menu.className='settings-menu two-columns';
    menu.append(group(row('目标检测模型',m.name||'—'),row('目标跟踪',m.tracker||'—'),row('推理后端',m.backend||'—'),row('模型状态',m.ready?'就绪':m.error||'未就绪')),
      group(row('RKNN 运行库',(m.sdk_version||'—').split(' (')[0]),row('NPU',m.npu&&m.npu.used?'正在推理':'未运行'),row('录像编码',m.vpu&&m.vpu.backend||'—'),note(m.vpu&&m.vpu.note||'实际运行状态由设备返回。')));
    menu.append(button('刷新信息',()=>$('#refresh-model-info').click()));
  }
  function renderLogs(){
    const list=group();(state.logs&&state.logs.items||[]).forEach(item=>list.append(row(item.name,bytesText(item.size_bytes),()=>{selectedLog=item;go('logDetail');},'更新于 '+dateText(item.modified_at))));
    menu.append(list,note('诊断包包含应用日志、设备状态和模型信息，不包含录像和事件截图。'),button('刷新列表',()=>$('#refresh-logs').click()),downloadLink('/api/logs/download','导出诊断包'));
  }
  core.onDiagnostics=()=>{if(state.page==='settings'&&['model','logs'].includes(route))renderRoute();};
  function renderDevice() {
    const s=state.connected?state.status:null, sys=s&&s.system||{}, mem=sys.memory||{}, storage=s&&s.storage||{};
    systemClone.className='two-columns';systemClone.append(group(row('设备',sys.hostname||'—'),row('局域网地址',window.HostControl?HostControl.address():location.host),row('芯片温度',sys.temperature_c==null?'—':sys.temperature_c+' °C'),row('CPU 使用率',sys.cpu_percent==null?'—':sys.cpu_percent+' %')),
      group(row('内存使用',bytesText(mem.used_bytes)+' / '+bytesText(mem.total_bytes)),row('存储可用',bytesText(storage.free_bytes)),row('系统',sys.os||'—'),row('连续运行',s&&Number.isFinite(s.uptime_seconds)?Math.floor(s.uptime_seconds/60)+' 分钟':'—')));
  }
  function renderService() {
    let running=state.connected; if(window.HostControl)running=HostControl.running();
    menu.append(group(row('录像服务',running?'运行中':'已停止'),row('局域网服务',running?'端口 8080':'未启动'),row('开机恢复',window.HostControl?(HostControl.enabled()?'已启用':'已取消'):'请在主机查看')),
      note('停止录像会完成当前片段写入，再停止采集、识别与局域网访问，并取消开机恢复。'));
    if(window.HostControl)menu.append(button(running?'停止录像…':'启动录像',()=>running?confirmStop():HostControl.start(),running?'secondary':'primary'));
  }
  function backPage() {
    const dialog=$('dialog[open]');if(dialog){dialog.close();return true;}
    if($('.detail-fullscreen')){$('.detail-fullscreen').classList.remove('detail-fullscreen');return true;}
    if(state.page==='settings'&&route!=='home'){go(parents[route]||'home');return true;}
    if(detail){closeDetail();core.setPage('live');return true;}
    if(state.page!=='live'){core.setPage('live');return true;}return false;
  }
  window.AiRecUI={back:backPage,exportState,nativeState:()=>{if(state.page==='settings'&&route==='service')renderRoute();updateStatus();}};
  core.onPage=()=>{ if($('#media-dialog').open)$('#media-dialog').close();if(detail)closeDetail(); if(state.page==='settings')renderRoute();updateStatus(); };
  core.onConfig=configureCards;
  core.onStatus=()=>{updateStatus();if(state.page==='settings'&&['device','service'].includes(route))renderRoute();};
  function updateStatus() {
    const channels=state.status&&state.status.channels||[];
    const count=state.connected?channels.filter(c=>c.state==='online').length:0;
    subtitle.textContent=state.connected?count+' / 5 路在线 · 录像服务运行中':'正在连接录像机';
    const stopped=window.HostControl&&!HostControl.running();
    serviceState.hidden=!stopped;heading.hidden=stopped;$('#camera-grid').hidden=stopped;system.hidden=stopped;statusFoot.hidden=stopped;
    if(stopped){const starting=HostControl.enabled();serviceState.replaceChildren(el('h2','',starting?'正在启动录像机':'录像服务已停止'),note(starting?'正在检查摄像头访问权限、存储介质和识别模型…':'已有录像与配置保留。启动后恢复预览和局域网访问。'));if(!starting)serviceState.append(button('启动录像',()=>HostControl.start(),'primary'));}
    state.cards.forEach(card=>card.node.classList.toggle('online',card.online));
    if(detail&&!archive)refreshPreview();
    if(detail&&$('#detail-summary')){const c=channels.find(c=>c.id===channel), online=state.connected&&c&&c.state==='online';
      $('#detail-summary').textContent=online?'预览 '+Number(c.preview_fps||c.fps||0).toFixed(1)+' fps · 录像 '+Number(c.recording_fps||0).toFixed(1)+' fps':'暂无信号';
      $('#detail-state .option-value').textContent=online?(c.recording?'在线 · 连续录像':'在线 · 未录像'):(state.connected?'暂无信号':'连接中断');
      $('#detail-mode .option-value').textContent=archive?'录像回放':'实时画面';
    }
  }

  const detailPage=el('section','page channel-detail');detailPage.id='host-channel';detailPage.hidden=true;$('main').append(detailPage);
  let preview,video,previewMessage,dateInput,track,scroll,position,eventsPanel,tab='recordings',timelineError;
  function closeDetail() {
    detail=false;state.detailChannel=0;sequence++;eventSequence++;clearTimeout(scrollTimer);detailPage.hidden=true;
    if(preview)preview.removeAttribute('src');if(video){video.pause();video.removeAttribute('src');video.load();}
  }
  function refreshPreview() {
    const c=(state.status&&state.status.channels||[]).find(c=>c.id===channel), online=state.connected&&c&&c.state==='online'&&!document.hidden;
    preview.hidden=!online;previewMessage.hidden=online;
    previewMessage.textContent=state.connected?(c&&c.error||'暂无信号'):'正在重新连接';
    if(online&&!preview.getAttribute('src'))preview.src='/stream/'+channel+'.mjpg';
    if(!online)preview.removeAttribute('src');
  }
  function openChannel(id) {
    closeDetail();channel=id;core.setPage('live');detail=true;archive=false;state.detailChannel=id;
    for(const card of state.cards.values())core.stopStream(card);
    $('#page-live').hidden=true;detailPage.hidden=false;detailPage.replaceChildren();
    const head=el('div','workspace-head');head.append(button('‹',()=>{closeDetail();state.detailChannel=0;core.setPage('live');}),el('h2','','AHD'+id),button('通道设置',()=>{closeDetail();state.detailChannel=0;go('channel');}));
    const layout=el('div','channel-layout'),left=el('div','detail-left'),screen=el('div','detail-screen');
    preview=el('img');preview.alt='AHD'+id+'实时画面';video=el('video');video.controls=true;video.playsInline=true;video.hidden=true;
    previewMessage=el('span','preview-message');screen.append(preview,video,previewMessage);
    const controls=el('div','video-tools');controls.append(button('返回实时',()=>{archive=false;currentClip=null;video.pause();video.removeAttribute('src');video.load();video.hidden=true;refreshPreview();}),button('全屏',()=>{screen.classList.toggle('detail-fullscreen');}),button('退出全屏',()=>screen.classList.remove('detail-fullscreen')));
    screen.append(controls);left.append(screen);
    const summary=el('div','video-summary');summary.id='detail-summary';const statusRow=row('当前状态','—'),modeRow=row('当前模式','实时画面');statusRow.id='detail-state';modeRow.id='detail-mode';left.append(summary,group(statusRow,modeRow));
    const right=el('section','timeline-panel'),tabs=el('div','tabs');
    const timelinePanel=el('div','day-panel');eventsPanel=el('div','detail-events');eventsPanel.hidden=true;
    const playbackTab=button('回放',()=>setTab('recordings')),eventTab=button('事件',()=>setTab('events'));
    function setTab(value){tab=value;eventsPanel.hidden=value!=='events';timelinePanel.hidden=value!=='recordings';playbackTab.classList.toggle('selected',value==='recordings');eventTab.classList.toggle('selected',value==='events');if(value==='events')loadChannelEvents();}
    tabs.append(playbackTab,eventTab);setTab('recordings');
    dateInput=el('input');dateInput.type='date';dateInput.value=localDate();dateInput.max=localDate();dateInput.onchange=()=>loadDay();
    const dateRow=el('div','date-row');dateRow.append(button('‹',()=>changeDay(-1)),dateInput,button('›',()=>changeDay(1)));
    const zoom=el('div','zoom-row');zoom.append(button('全天',()=>{precise=false;drawTimeline();}),button('精细',()=>{precise=true;drawTimeline();}));
    position=el('div','timeline-position');timelineError=el('p','footnote');
    const legend=el('div','timeline-legend');['dwell','person','vehicle','animal'].forEach((type,i)=>{const t=el('span','event-'+type,['停留','人','车','动物'][i]);t.prepend(el('i','event-dot'));legend.append(t);});
    const viewport=el('div','timeline-viewport');scroll=el('div','timeline-scroll');track=el('div','timeline-track');scroll.append(track);viewport.append(scroll,el('div','time-cursor'));
    scroll.onpointerdown=()=>{if(video)video.pause();};
    scroll.onscroll=()=>{clearTimeout(scrollTimer);if(!day)return;selectedTime=day.start+scroll.scrollTop/Number(track.dataset.height)*(day.end-day.start);position.textContent=new Date(selectedTime).toLocaleTimeString('zh-CN',{hour12:false});scrollTimer=setTimeout(()=>seek(selectedTime),350);};
    timelinePanel.append(dateRow,zoom,legend,position,timelineError,viewport,note('上下滑动选择时间；蓝色为录像，空白为无录像。'));
    right.append(tabs,timelinePanel,eventsPanel);layout.append(left,right);detailPage.append(head,layout);refreshPreview();loadDay();
    preview.onerror=()=>{preview.removeAttribute('src');preview.hidden=true;previewMessage.hidden=false;previewMessage.textContent='预览中断，正在重连';};
    video.onerror=()=>{previewMessage.hidden=false;previewMessage.textContent='录像暂不可用，请重选时间或返回实时';};
    video.ontimeupdate=()=>{if(currentClip&&day&&currentClip.start+video.currentTime*1000>=Math.min(day.end,currentClip.end)-100){video.pause();const next=index.recordings.find(r=>r.start>=currentClip.end-150&&r.start<=currentClip.end+150&&r.id!==currentClip.id);if(next&&next.start<day.end)seek(next.start);}};
    video.onended=()=>{const next=currentClip&&index.recordings.find(r=>r.start>=currentClip.end-150&&r.start<=currentClip.end+150&&r.id!==currentClip.id);if(next&&next.start<day.end)seek(next.start);};
  }
  function localDate(d=new Date()){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  function changeDay(delta){const d=new Date(dayWindow(dateInput.value).start);d.setDate(d.getDate()+delta);if(localDate(d)>localDate())return;dateInput.value=localDate(d);loadDay();}
  async function loadDay() {
    archive=false;currentClip=null;if(video){video.pause();video.removeAttribute('src');video.load();video.hidden=true;}refreshPreview();
    const token=++sequence;clearTimeout(scrollTimer);index={recordings:[],events:[]};track.replaceChildren();scroll.style.pointerEvents='none';
    try {
      day=dayWindow(dateInput.value);selectedTime=Math.min(Date.now(),day.end-1);timelineError.textContent='正在读取全天录像…';
      const data=await api('/api/timeline?channel_id='+channel+'&start='+encodeURIComponent(new Date(day.start).toISOString())+'&end='+encodeURIComponent(new Date(day.end).toISOString()));
      if(token!==sequence||!detail)return;index=decodeIndex(data,channel,day,mediaUrl);timelineError.textContent='';scroll.style.pointerEvents='auto';drawTimeline();
    } catch(e){if(token===sequence){timelineError.replaceChildren(el('span','',e.message),button('重试',loadDay));}}
  }
  function drawTimeline() {
    clearTimeout(scrollTimer);const height=precise?8640:1440;track.dataset.height=height;
    const half=scroll.clientHeight/2;track.style.height=(height+half*2)+'px';track.replaceChildren();
    const y=t=>half+(t-day.start)/(day.end-day.start)*height;
    for(let t=day.start;t<=day.end;t+=3600000){const tick=el('div','timeline-tick',t===day.end?'24:00':new Date(t).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false}));tick.style.top=y(t)+'px';track.append(tick);}
    index.recordings.forEach(r=>{const b=el('div','timeline-recording');b.style.top=y(Math.max(day.start,r.start))+'px';b.style.height=Math.max(2,y(Math.min(day.end,r.end))-y(Math.max(day.start,r.start)))+'px';track.append(b);});
    index.events.forEach(r=>{if(r.end<=day.start||r.start>=day.end)return;const b=el('div','timeline-event event-'+r.type);b.style.top=y(Math.max(day.start,r.start))+'px';b.style.height=Math.max(3,y(Math.min(day.end,r.end))-y(Math.max(day.start,r.start)))+'px';track.append(b);});
    // 程序定位不触发自动播放，只有用户手势改变时间才 seek。
    const handler=scroll.onscroll;scroll.onscroll=null;scroll.scrollTop=(selectedTime-day.start)/(day.end-day.start)*height;
    position.textContent=new Date(selectedTime).toLocaleTimeString('zh-CN',{hour12:false});requestAnimationFrame(()=>requestAnimationFrame(()=>{if(detail)scroll.onscroll=handler;}));
  }
  function seek(time) {
    if(!detail||!day||!Number.isFinite(time))return;time=Math.max(day.start,Math.min(day.end-1,time));archive=true;preview.removeAttribute('src');preview.hidden=true;
    const clip=atTime(index.recordings,time);currentClip=clip;video.pause();
    if(!clip){video.hidden=true;video.removeAttribute('src');video.load();previewMessage.hidden=false;previewMessage.textContent='所选时间没有可用录像';return;}
    video.hidden=false;previewMessage.hidden=true;
    const offset=(time-clip.start)/1000;
    const play=()=>{video.currentTime=offset;video.play().catch(()=>{});};
    if(video.getAttribute('src')===clip.url&&video.readyState>=1)play();else{video.onloadedmetadata=play;video.src=clip.url;video.load();}
  }
  async function loadChannelEvents(type='') {
    const token=++eventSequence;eventsPanel.replaceChildren();const filters=el('div','chips');['','dwell','person','vehicle','animal'].forEach((t,i)=>filters.append(button(['全部','停留','人','车','动物'][i],()=>loadChannelEvents(t))));eventsPanel.append(filters);
    try{const data=await api('/api/events?channel_id='+channel+(type?'&event_type='+type:''));if(!detail||token!==eventSequence)return;(data.items||[]).forEach(item=>{const entry=button('',()=>openEvent(item),'channel-event');const thumb=el('img');const src=mediaUrl(item.snapshot_url);if(src)thumb.src=src;thumb.alt='事件截图';const text=el('span');const label=el('span','event-label');label.append(el('i','event-dot '+item.event_type),el('span','',({person:'人',vehicle:'车',animal:'动物',dwell:'长时间停留'})[item.event_type]||'事件'));text.append(label,el('small','',dateText(item.created_at)));entry.append(thumb,text,el('span','chevron','›'));eventsPanel.append(entry);});if(!data.items.length)eventsPanel.append(note('暂无匹配事件'));}catch(e){if(token===eventSequence)eventsPanel.append(note(e.message));}
  }
  function openEvent(item) {
    $('#media-title').textContent='事件详情';const content=$('#media-content');content.className='event-detail-content';content.replaceChildren();
    const image=el('img');const url=mediaUrl(item.snapshot_url);if(url)image.src=url;image.alt='事件截图';
    const info=group(row('事件类型',({person:'人',vehicle:'车',animal:'动物',dwell:'长时间停留'})[item.event_type]||'事件'),row('通道','AHD'+item.channel_id),row('发生时间',dateText(item.created_at)));
    if(item.event_type==='dwell')info.append(row('停留时长',item.dwell_seconds+' 秒'));
    const actions=el('div','dialog-actions');actions.append(downloadLink(item.snapshot_url,'导出截图'));
    if(item.recording_available&&mediaUrl(item.recording_url))actions.append(button('查看关联录像',()=>core.openMedia('video',item.recording_url,'关联录像')));
    content.append(image,info,actions);$('#media-note').textContent='';if(!$('#media-dialog').open)$('#media-dialog').show();
  }
  core.openEvent=openEvent;
  state.cards.forEach(card=>{card.screen.tabIndex=0;card.screen.setAttribute('role','button');card.screen.setAttribute('aria-label','打开 AHD'+card.id+' 详情');card.screen.onclick=()=>openChannel(card.id);card.screen.onkeydown=e=>{if(e.key==='Enter')openChannel(card.id);};});
  document.addEventListener('visibilitychange',()=>{if(detail){if(document.hidden){preview.removeAttribute('src');video.pause();}else if(!archive)refreshPreview();}});
  core.onInvalid=input=>{const card=input.closest('[data-channel-id]');if(card){channel=Number(card.dataset.channelId);go(input.closest('[data-panel]').dataset.panel);}else go('storage');input.reportValidity();};
  core.onPage();
}
