import {createHandTracker} from './hand-math.mjs';
import {createTrackingSchedule,readPerformanceSettings,trackingProfile,trackingModel,createFrameCapture} from './performance.mjs?v=20261107-toolbar2';
import {createModelMemory} from './adaptive-model.mjs?v=20261107-toolbar2';
let preferenceStorage;try{preferenceStorage=window.localStorage;}catch{}
const settings=readPerformanceSettings({search:window.location?.search||'',storage:preferenceStorage}),android=/Android/i.test(navigator.userAgent||''),config=trackingProfile(settings.profile,android),modelMemory=createModelMemory(preferenceStorage,{engine:settings.engine,numHands:config.numHands,profile:settings.profile}),modelConfig=trackingModel(settings.model==='auto'?(modelMemory.read()||'auto'):settings.model,android),schedule=createTrackingSchedule(android,settings.profile),capture=createFrameCapture();
const $=id=>document.getElementById(id);
$('playerModeHint').textContent=config.numHands===1?'單人模式：舉起一隻手控制光圈':'一人或二人，各舉一手控制光圈';
$('handCapacityCopy').textContent=config.numHands===1?'單人省電：每隻手 21 個關鍵點。':'每隻手 21 個關鍵點，最多兩手合作尋寶。';
const video=$('cameraVideo'),overlay=$('handOverlay'),ink=overlay.getContext('2d');
const reality=$('liveCameraCanvas'),liveInk=reality.getContext('2d'),positionCanvas=$('palmMap'),mapInk=positionCanvas.getContext('2d');
let showDiagnostics=settings.diagnostics;
let lastPreview=0,previewFrames=0,trail=[],captureStart=0,lastReport=0,reportFrames=0,reportGameFrames=0;
const handTracker=createHandTracker();let trackedHands=[];
new ResizeObserver(()=>{const r=positionCanvas.getBoundingClientRect();if(!r.width||!r.height)return;const scale=Math.min(1.5,480/r.width,320/r.height),w=Math.round(r.width*scale),h=Math.round(r.height*scale);if(positionCanvas.width!==w||positionCanvas.height!==h){positionCanvas.width=w;positionCanvas.height=h;trail=[];}}).observe(positionCanvas);
const connections=[[0,1,2,3,4],[0,5,6,7,8],[5,9,10,11,12],[9,13,14,15,16],[13,17,18,19,20],[0,17]];
let stream,worker,busy=false,frameId=0,lastFrame=0,lastVideoTime=-1,position=null,generation=0;
let mode='mouse',ready=false,mirror=true,reach=.15,starting=false,cancelModel=null,lastMotion=0;
const diagnostics={state:'idle',frames:0,hands:0,ms:0,error:null,delegate:'CPU',averageMs:0,inputWidth:schedule.width,profile:settings.profile,model:modelConfig.id,automaticModel:settings.model==='auto',modelChanging:false,numHands:config.numHands,captureMs:0,roundTripMs:0,pendingMs:0,inFlight:0,trackingFps:0,renderFps:0};
function status(text,state) {
  $('cameraStatus').textContent=text;diagnostics.state=state;
  $('cameraPill').textContent=text;$('cameraPill').dataset.state=state;
  $('pipelineMessage').textContent=text;
  $('welcomeHandStatus').textContent=text;
  $('cameraPanel').dataset.diagnostics=JSON.stringify(diagnostics);
}
function deactivate(){window.portalHands([]);position=null;}
function telemetry(point,active=false){
  const mouseOwns=$('mainView').dataset.inputSource==='mouse';
  $('aiLive').dataset.active=String(active);$('aiGesture').textContent=trackedHands.length===2?'兩手合作':point?(point.open?'張開手掌':'合起手掌'):'等待手掌';
  $('landmarkCount').textContent=trackedHands.length?`${trackedHands.length} 隻手 · ${trackedHands.length*21} 個關鍵點`:'未偵測到手掌';
  $('controlCommand').textContent=mouseOwns?'滑鼠控制光圈':active?'光圈移動中':'光圈暫停';
  if(point){for(const [key,value]of [['X',point.x],['Y',point.y]]){$('position'+key).value=value;$('position'+key+'Text').textContent=Math.round(value*100)+'%';}}
  else{$('positionXText').textContent='—';$('positionYText').textContent='—';$('positionX').value=0;$('positionY').value=0;}
  if(!active){$('directionArrow').textContent='○';$('directionText').textContent=point?(point.open?'設定中':'合起暫停'):'等待手掌';}
  if(mouseOwns){$('directionArrow').textContent='↖';$('directionText').textContent='滑鼠接手';}
  drawPosition(point,active);
}
function drawPosition(point,active){
 const w=positionCanvas.width,h=positionCanvas.height;mapInk.fillStyle='#101e18';mapInk.fillRect(0,0,w,h);mapInk.strokeStyle='#53674744';mapInk.lineWidth=.65;
 for(let i=1;i<4;i++){mapInk.beginPath();mapInk.moveTo(i*w/4,0);mapInk.lineTo(i*w/4,h);mapInk.moveTo(0,i*h/4);mapInk.lineTo(w,i*h/4);mapInk.stroke();}
 mapInk.fillStyle='#859c75';mapInk.font='17px sans-serif';mapInk.fillText('左',8,24);mapInk.fillText('右',w-26,24);
 for(let id=0;id<2;id++){
  const control=trackedHands.find(p=>p.id===id),path=trail[id]??=[];
  if(!control){trail[id]=[];continue;}
  if(active&&control.open){path.push({x:control.x,y:control.y});if(path.length>28)path.shift();}
  const color=id?'#78f0ce':'#eddf9b';mapInk.strokeStyle=color+'99';mapInk.lineWidth=1.1;mapInk.lineCap='round';mapInk.lineJoin='round';
  if(path.length>1){mapInk.beginPath();mapInk.moveTo(path[0].x*w,path[0].y*h);for(let i=1;i<path.length-1;i++){const a=path[i],b=path[i+1];mapInk.quadraticCurveTo(a.x*w,a.y*h,(a.x+b.x)*w/2,(a.y+b.y)*h/2);}mapInk.lineTo(path.at(-1).x*w,path.at(-1).y*h);mapInk.stroke();}
  const x=control.x*w,y=control.y*h;mapInk.strokeStyle=color;mapInk.beginPath();mapInk.arc(x,y,11,0,Math.PI*2);mapInk.stroke();mapInk.fillStyle=color;mapInk.beginPath();mapInk.arc(x,y,3.5,0,Math.PI*2);mapInk.fill();mapInk.fillText('P'+(id+1),x+15,y-7);
 }
}
function drawReality(now){
  if(now-lastPreview<1000/config.previewFps||video.readyState<2||document.hidden)return;lastPreview=now;
  const w=reality.width,h=reality.height,scale=Math.min(w/video.videoWidth,h/video.videoHeight),dw=video.videoWidth*scale,dh=video.videoHeight*scale;
  liveInk.fillStyle='#0e1711';liveInk.fillRect(0,0,w,h);liveInk.save();if(mirror){liveInk.translate(w,0);liveInk.scale(-1,1);}liveInk.drawImage(video,(w-dw)/2,(h-dh)/2,dw,dh);liveInk.restore();
  previewFrames++;$('liveFrameLabel').textContent='即時影像 · '+previewFrames+' 幀';reality.dataset.frames=previewFrames;
}
function direction(next,previous){
  const dx=previous?next.x-previous.x:0,dy=previous?next.y-previous.y:0;
  if(Math.hypot(dx,dy)>.008){const i=(Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8;$('directionArrow').textContent=['→','↘','↓','↙','←','↖','↑','↗'][i];$('directionText').textContent=['向右','向右下','向下','向左下','向左','向左上','向上','向右上'][i];lastMotion=performance.now();}
  else if(performance.now()-lastMotion>450){$('directionArrow').textContent='◎';$('directionText').textContent='停留選取';}
}
function drawHand(hands=[]) {
  ink.clearRect(0,0,overlay.width,overlay.height);
  overlay.dataset.landmarks=hands?.length*21||0;
  if(!hands?.length)return;
  for(const hand of hands){const points=hand.points;
  const scale=Math.min(overlay.width/(video.videoWidth||640),overlay.height/(video.videoHeight||480)),dw=(video.videoWidth||640)*scale,dh=(video.videoHeight||480)*scale;
  const xy=p=>[(overlay.width-dw)/2+(mirror?1-p.x:p.x)*dw,(overlay.height-dh)/2+p.y*dh];
  ink.save();ink.shadowColor='#07110ed0';ink.shadowBlur=0;ink.strokeStyle='#00e676';ink.lineWidth=2.7;ink.lineCap='round';ink.lineJoin='round';
  for(const chain of connections){ink.beginPath();chain.forEach((i,j)=>ink[j?'lineTo':'moveTo'](...xy(points[i])));ink.stroke();}
  ink.fillStyle='#39ff6a';for(const p of points){ink.beginPath();ink.arc(...xy(p),3.6,0,Math.PI*2);ink.fill();}
  const palm=[0,5,9,13,17].reduce((p,i)=>({x:p.x+points[i].x/5,y:p.y+points[i].y/5}),{x:0,y:0});
  ink.strokeStyle='#6cff99';ink.lineWidth=2.5;ink.beginPath();ink.arc(...xy(palm),14,0,Math.PI*2);ink.stroke();ink.shadowBlur=0;ink.fillStyle='#e9ffe9';ink.font='bold 17px sans-serif';ink.fillText('P'+(hand.id+1),...xy({...palm,y:palm.y-.06}));ink.restore();
  }
}
function result(data) {
  busy=false;diagnostics.frames++;diagnostics.ms=Math.round(data.ms);diagnostics.roundTripMs=Math.round(performance.now()-captureStart);
  const now=performance.now();diagnostics.model=data.model||diagnostics.model;diagnostics.delegate=data.delegate||diagnostics.delegate;diagnostics.fallback=!!data.fallback;diagnostics.fallbackReason=data.reason||'';schedule.complete(data.ms,now,diagnostics.delegate);diagnostics.averageMs=Math.round(schedule.averageMs);diagnostics.inputWidth=schedule.width;window.portalHandTimeout=schedule.staleMs;trackedHands=handTracker.update(data.hands??(data.landmarks?[data.landmarks]:[]),now,mirror,reach);diagnostics.hands=trackedHands.length;
  drawHand(trackedHands);
  if(mode!=='hand')return;
  const canControl=$('cameraPanel').hidden,accepted=window.portalHands(trackedHands.map(h=>({id:h.id,x:h.x,y:h.y,active:canControl&&h.open})));
  const point=trackedHands.find(h=>h.open)||trackedHands[0];
  if(!point){position=null;telemetry(null);status(config.numHands===1?'單人省電：舉起一隻張開嘅手掌':'每人舉起一手，最多兩人合作尋寶','searching');return;}
  const previous=position;position=point;
  telemetry(point,canControl&&accepted&&point.open);if(canControl&&accepted&&point.open)direction(point,previous);
  if(!point.open){status('手掌合起：暫停 · 張開繼續','paused');return;}
  if(canControl&&!accepted){$('directionArrow').textContent='↖';$('directionText').textContent='滑鼠接手';$('controlCommand').textContent='滑鼠控制光圈';}
  status(canControl?(accepted?(trackedHands.length===2?'雙人合作 · 每人用一隻手控制光圈':config.numHands===1?'單人手掌追蹤中':'手掌追蹤中 · 可加入第二位玩家'):'滑鼠優先 · 停低約三秒恢復手勢'):'設定中 · 關閉設定繼續遊戲','tracking');
}
function model() {
  return new Promise((resolve,reject)=>{
    worker=new Worker(new URL('./hand-worker.mjs?v=20261107-toolbar2',import.meta.url),{type:'module'});
    const timer=setTimeout(()=>reject(new Error('追蹤模型載入逾時，請重新試一次。')),45000);
    cancelModel=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
    worker.onmessage=({data})=>{
      if(data.type==='ready'){clearTimeout(timer);cancelModel=null;ready=true;diagnostics.model=data.model||diagnostics.model;diagnostics.delegate=data.delegate||'CPU';resolve();}
      if(data.type==='result')result(data);
      if(data.type==='model-choice'&&settings.model==='auto'){modelMemory.save(data.model);diagnostics.modelSelectionReason=data.reason;}
      if(data.type==='model-changing'){
        busy=true;diagnostics.modelChanging=true;trackedHands=[];deactivate();drawHand([]);telemetry(null);
        status('自動調節辨識模型，光圈暫停片刻…','adapting');
      }
      if(data.type==='model-ready'){
        busy=false;diagnostics.modelChanging=false;diagnostics.model=data.model;diagnostics.delegate=data.delegate;diagnostics.modelSelectionReason=data.selectionReason;
        schedule.reset();diagnostics.ms=0;diagnostics.averageMs=0;diagnostics.roundTripMs=0;diagnostics.pendingMs=0;diagnostics.inFlight=0;lastFrame=performance.now();
        status(data.selectionReason==='model-load-failed'?'保留原有模型，請張開手掌繼續':'已自動選用 '+trackingModel(data.model).label+'，請張開手掌繼續','searching');
      }
      if(data.type==='error'){clearTimeout(timer);reject(new Error(data.message));if(ready)fail(new Error(data.message));}
    };
    worker.onerror=e=>{clearTimeout(timer);reject(new Error(e.message||'追蹤模型未能啟動'));if(ready)fail(new Error('追蹤模型停止，請重新啟動鏡頭。'));};
    const initialModel=settings.model==='auto'?(modelMemory.read()||modelConfig.id):modelConfig.id;diagnostics.model=initialModel;
    worker.postMessage({type:'init',model:initialModel,automatic:settings.model==='auto',numHands:config.numHands,gpu:settings.engine!=='cpu'});
  });
}
async function pump(now) {
  frameId=requestAnimationFrame(pump);
  if(mode==='hand')drawReality(now);reportPerformance(now);
  if(mode!=='hand'||!ready||busy||document.hidden||video.readyState<2||!schedule.canSend(now,lastFrame)||video.currentTime===lastVideoTime)return;
  busy=true;lastFrame=now;lastVideoTime=video.currentTime;
  const current=generation;
  try {
    captureStart=performance.now();const bitmap=await capture.capture(video,schedule.width);diagnostics.captureMs=Math.round(performance.now()-captureStart);
    if(current!==generation||!worker){bitmap.close();busy=false;return;}
    worker.postMessage({type:'frame',bitmap,timestamp:now},[bitmap]);
  } catch(error){busy=false;fail(error);}
}
function stop() {
  generation++;schedule.reset();window.portalHandTimeout=450;handTracker.clear();trackedHands=[];trail=[];starting=false;diagnostics.modelChanging=false;cancelModel?.();cancelModel=null;cancelAnimationFrame(frameId);worker?.terminate();worker=null;ready=false;busy=false;
  stream?.getTracks().forEach(t=>t.stop());stream=null;video.srcObject=null;drawHand(null);deactivate();telemetry(null);
  liveInk.clearRect(0,0,reality.width,reality.height);$('liveFrameLabel').textContent='鏡頭未啟動';previewFrames=0;
  $('liveTag').textContent='OFF';
  $('cameraStart').disabled=false;$('cameraStart').textContent='啟動鏡頭';$('cameraStop').hidden=true;
  $('cameraPlaceholder').hidden=false;$('cameraPicker').hidden=true;mode='mouse';window.portalControlMode='mouse';
  $('welcomeCamera').disabled=false;$('welcomeCamera').textContent='開啟鏡頭，揮手入畫';
}
function fail(error) {
  stop();diagnostics.error=error.message;
  const messages={NotAllowedError:'未獲鏡頭許可。請按網址旁嘅鏡頭圖示允許，再重新啟動。',NotFoundError:'搵唔到鏡頭，請接駁 USB 鏡頭後重試。',NotReadableError:'鏡頭可能被其他程式使用，請關閉其他視像程式後重試。',OverconstrainedError:'此鏡頭未能使用目前設定，請揀另一個鏡頭。',SecurityError:'瀏覽器未能使用鏡頭，請用 Chrome 或 Edge 開本機網址。'};
  status(messages[error.name]||('鏡頭未能啟動：'+error.message),'error');
}
async function start(deviceId) {
  if(starting)return;stop();starting=true;const token=generation;mode='loading';window.portalControlMode='loading';
  $('cameraStart').disabled=true;$('cameraStart').textContent='正在啟動…';status('正在啟動鏡頭及手掌追蹤…','loading');diagnostics.error=null;
  $('welcomeCamera').disabled=true;$('welcomeCamera').textContent='正在啟動鏡頭…';
  try {
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia)throw new Error('鏡頭需要 HTTPS 或本機網址，請用新版 Chrome／Edge 開啟遊戲。');
    const cameraVideo={width:{ideal:config.cameraWidth},height:{ideal:config.cameraHeight},frameRate:{ideal:config.cameraFps,max:config.cameraFps},...(deviceId?{deviceId:{exact:deviceId}}:{facingMode:'user'})};
    let acquired;
    try{acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:{...cameraVideo,width:{...cameraVideo.width,max:config.cameraWidth},height:{...cameraVideo.height,max:config.cameraHeight}}});}
    catch(error){if(error.name!=='OverconstrainedError')throw error;acquired=await navigator.mediaDevices.getUserMedia({audio:false,video:cameraVideo});}
    if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;
    video.srcObject=stream;await video.play();const actual=stream.getVideoTracks()[0].getSettings();diagnostics.cameraWidth=actual.width||video.videoWidth;diagnostics.cameraHeight=actual.height||video.videoHeight;diagnostics.cameraFps=actual.frameRate||0;
    $('liveTag').textContent='LIVE';
    if(token!==generation)return;
    await model();
    if(token!==generation)return;
    mode='hand';window.portalControlMode='hand';lastVideoTime=-1;
    $('welcomeCamera').disabled=false;$('welcomeCamera').textContent='揮手入畫 · 停留開始';
    $('cameraStart').disabled=false;$('cameraStart').textContent='重新啟動';$('cameraStop').hidden=false;$('cameraPlaceholder').hidden=true;$('cameraPanel').hidden=true;
    const devices=(await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput');
    $('cameraSelect').replaceChildren(...devices.map((d,i)=>{const o=document.createElement('option');o.value=d.deviceId;o.textContent=d.label||`鏡頭 ${i+1}`;return o;}));
    $('cameraSelect').value=stream.getVideoTracks()[0].getSettings().deviceId||'';$('cameraPicker').hidden=devices.length<2;
    const track=stream.getVideoTracks()[0];track.onended=()=>{if(mode==='hand')fail(new Error('鏡頭已中斷，請重新啟動。'));};
    status('鏡頭已就緒，請舉起張開嘅手掌','searching');frameId=requestAnimationFrame(pump);
  } catch(error){if(token===generation&&error.name!=='AbortError')fail(error);} finally {if(token===generation)starting=false;}
}
function reportPerformance(now){
 if(now-lastReport<1000)return;
 const gameFrames=window.portalGame?.getState().frames||0,seconds=(now-lastReport)/1000;
 diagnostics.trackingFps=Math.round((diagnostics.frames-reportFrames)/seconds*10)/10;diagnostics.renderFps=Math.round((gameFrames-reportGameFrames)/seconds);
 reportFrames=diagnostics.frames;reportGameFrames=gameFrames;lastReport=now;
 diagnostics.inFlight=busy?1:0;diagnostics.pendingMs=busy?Math.round(now-captureStart):0;
 $('cameraPanel').dataset.diagnostics=JSON.stringify(diagnostics);
 if(showDiagnostics)updatePerformanceText();
}
function updatePerformanceText(){
 $('performanceStats').textContent=`${config.name} · ${diagnostics.delegate} · ${config.numHands} 手\nAI ${trackingModel(diagnostics.model).label}：${diagnostics.ms} ms\n平均：${diagnostics.averageMs} ms\n取像：${diagnostics.captureMs} ms\n總往返：${diagnostics.roundTripMs} ms\n目前等待：${diagnostics.pendingMs} ms\n辨識：${diagnostics.trackingFps} 次／秒\n畫面：${diagnostics.renderFps} fps\n鏡頭：${diagnostics.cameraWidth||0}×${diagnostics.cameraHeight||0} @ ${Math.round(diagnostics.cameraFps||0)}\n輸入：${capture.size.join('×')} · ${diagnostics.inFlight} 張`;
}
function setDiagnostics(visible){
 showDiagnostics=visible;$('performancePanel').hidden=!visible;
 $('aiDock').classList[visible?'add':'remove']('showPerformance');$('welcome').style.right=visible?'var(--side)':'';
 $('togglePerformance').textContent=visible?'收起數據':'效能數據';$('togglePerformance').setAttribute('aria-pressed',String(visible));
 if(visible)updatePerformanceText();
}
$('performanceMode').value=settings.profile;$('performanceEngine').value=settings.engine;$('performanceModel').value=settings.model;
$('togglePerformance').onclick=()=>setDiagnostics(!showDiagnostics);
$('hidePerformance').onclick=()=>setDiagnostics(false);
$('applyPerformance').onclick=()=>{
 const profile=$('performanceMode').value,engine=$('performanceEngine').value,model=$('performanceModel').value;try{preferenceStorage?.setItem('qingming.performance.v2',JSON.stringify({profile}));}catch{}
 const url=new URL(window.location.href);url.searchParams.set('performance',profile);url.searchParams.set('engine',engine);url.searchParams.set('model',model);url.searchParams.delete('diagnostics');window.location.href=url.href;
};
setDiagnostics(showDiagnostics);
$('cameraStart').onclick=()=>start();
$('cameraStop').onclick=()=>{stop();status('已關閉鏡頭 · 可用滑鼠試玩','idle');};
const enterMouseMode=()=>{$('welcome').hidden=true;$('cameraPanel').hidden=true;status('滑鼠同手勢都可操作，移動滑鼠即可接手',mode==='hand'?'tracking':'idle');};
$('mouseMode').onclick=enterMouseMode;
$('welcomeMouse').onclick=enterMouseMode;
$('welcomeCamera').onclick=()=>{if(mode==='hand'){$('welcome').hidden=true;$('cameraPanel').hidden=true;return;}start();};
$('quickCamera').onclick=()=>{$('cameraPanel').hidden=false;start();};
$('cameraClose').onclick=()=>{$('cameraPanel').hidden=true;};
$('cameraSelect').onchange=e=>start(e.target.value);
$('mirror').onchange=e=>{mirror=e.target.checked;video.style.transform=mirror?'scaleX(-1)':'none';position=null;handTracker.clear();trail=[];};
$('reach').oninput=e=>{reach=Number(e.target.value);position=null;handTracker.clear();trail=[];};
window.addEventListener('keydown',e=>{if(e.key.toLowerCase()==='c'&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.target.matches('input,select,textarea'))$('cameraPanel').hidden=!$('cameraPanel').hidden;});
document.addEventListener('visibilitychange',()=>{if(document.hidden)deactivate();});
window.addEventListener('pagehide',stop);
window.portalControlMode='mouse';drawHand(null);telemetry(null);status('鏡頭未啟動','idle');
start();
