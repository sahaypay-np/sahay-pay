/* Sahay Pay — standalone SPA. Vanilla JS, hash router, real API only, no fake data. */
(function(){
"use strict";
var I = window.SP_I18N;
function t(k,v){ return I.t(k,v); }

/* ---------- helpers ---------- */
function $(s, r){ return (r||document).querySelector(s); }
function $all(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }
function esc(s){ if(s==null) return ""; return String(s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function el(html){ var d=document.createElement("div"); d.innerHTML=html.trim(); return d.firstChild; }
function money(minor, cur){
  if(minor==null || isNaN(minor)) return cur==="INR" ? "₹ 0" : "रू 0";
  var n = Math.round(minor)/100;
  var sym = cur==="INR" ? "₹" : "रू";
  var code = cur==="INR" ? "INR" : "NPR";
  return sym + " " + n.toLocaleString("en-IN", {maximumFractionDigits:2}) + " " + code;
}
function moneyShort(minor, cur){ return money(minor, cur); }
function toMinor(rupees){ var n=parseFloat(rupees); if(isNaN(n)) return 0; return Math.round(n*100); }
function fromMinor(minor){ return (Math.round(minor||0)/100); }
function timeAgo(iso){
  if(!iso) return "";
  var d=new Date(iso); if(isNaN(d)) return "";
  var s=Math.floor((Date.now()-d.getTime())/1000);
  if(s<60) return t("time_just_now");
  if(s<3600) return t("time_min",{n:Math.floor(s/60)});
  if(s<86400) return t("time_hour",{n:Math.floor(s/3600)});
  return t("time_day",{n:Math.floor(s/86400)});
}
function fmtDate(iso){ if(!iso) return "—"; var d=new Date(iso); if(isNaN(d)) return esc(iso); return d.toLocaleDateString(); }
function initials(name){ if(!name) return "?"; var p=String(name).trim().split(/\s+/); return (p[0][0]||"?").toUpperCase()+((p[1]||"")[0]||"").toUpperCase(); }
function flag(country){ return country==="IN"||country==="India" ? "🇮🇳" : "🇳🇵"; }
function curOf(country){ return (country==="IN"||country==="India") ? "INR" : "NPR"; }
function countryCode(c){ return (c==="IN"||c==="India") ? "IN" : "NP"; }
function toast(msg, isErr){
  var root=$("#toast-root"); var d=document.createElement("div");
  d.className="toast"+(isErr?" err":""); d.textContent=msg; root.appendChild(d);
  setTimeout(function(){ d.remove(); }, 3600);
}
function showOfflineBanner(isOffline){
  var b=$("#offline-banner"); if(!b) return;
  $("#offline-text").textContent=isOffline?t("offline_msg"):t("conn_err_msg");
  b.hidden=false;
}
function hideOfflineBanner(){ var b=$("#offline-banner"); if(b) b.hidden=true; }
function copyText(text, msg){
  function done(){ toast(msg||t("copied")); }
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, function(){ fallback(); }); }
  else fallback();
  function fallback(){ var ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); try{ document.execCommand("copy"); done(); }catch(e){ toast(t("err_generic"), true); } ta.remove(); }
}
var lastFocus=null;
function closeSheets(){
  $("#sheet-root").innerHTML=""; $("#modal-root").innerHTML="";
  if(lastFocus && lastFocus.focus){ try{ lastFocus.focus(); }catch(e){} }
  lastFocus=null;
}
document.addEventListener("keydown", function(e){
  if(e.key==="Escape" && ($("#sheet-root").firstChild || $("#modal-root").firstChild)){ e.preventDefault(); closeSheets(); return; }
  if(e.key!=="Tab") return;
  var dlg=document.querySelector("#sheet-root [role=dialog], #modal-root [role=dialog]");
  if(!dlg) return;
  var f=Array.prototype.slice.call(dlg.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")).filter(function(n){ return !n.disabled; });
  if(!f.length) return;
  var first=f[0], last=f[f.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
});
function openSheet(html){
  var prev=document.activeElement;
  closeSheets();
  lastFocus=prev;
  var root=$("#sheet-root");
  var bd=el('<div class="sheet-backdrop"><div class="sheet" role="dialog" aria-modal="true" tabindex="-1"><button type="button" class="sheet-close" aria-label="'+esc(t("close"))+'">✕</button><div class="sheet-handle"></div>'+html+'</div></div>');
  bd.addEventListener("click", function(e){ if(e.target===bd) closeSheets(); });
  bd.querySelector(".sheet-close").addEventListener("click", closeSheets);
  root.appendChild(bd);
  var dlg=bd.querySelector(".sheet"); if(dlg) dlg.focus();
}
function openModal(html){
  var prev=document.activeElement;
  closeSheets();
  lastFocus=prev;
  var root=$("#modal-root");
  var bd=el('<div class="modal-backdrop"><div class="modal glass" role="dialog" aria-modal="true" tabindex="-1"><button type="button" class="modal-close" aria-label="'+esc(t("close"))+'">✕</button>'+html+'</div></div>');
  bd.addEventListener("click", function(e){ if(e.target===bd) closeSheets(); });
  bd.querySelector(".modal-close").addEventListener("click", closeSheets);
  root.appendChild(bd);
  var dlg=bd.querySelector(".modal"); if(dlg) dlg.focus();
}
function confirmDialog(title, body, okLabel, onOk, danger){
  openModal('<h2>'+esc(title)+'</h2><p>'+esc(body)+'</p><div class="btn-row"><button class="btn secondary" data-act="no">'+esc(t("cancel"))+'</button><button class="btn'+(danger?" danger":"")+'" data-act="yes">'+esc(okLabel)+'</button></div>');
  $("[data-act=no]", $("#modal-root")).onclick=closeSheets;
  $("[data-act=yes]", $("#modal-root")).onclick=function(){ closeSheets(); onOk(); };
}
function emptyState(icon, title, body, ctaHtml, heading){
  var h=heading||"h2";
  return '<div class="card empty"><div class="big">'+icon+'</div><'+h+'>'+esc(title)+'</'+h+'><p>'+esc(body)+'</p>'+(ctaHtml||"")+'</div>';
}
function errBox(msg, heading){
  var h=heading||"h2";
  return '<div class="card empty"><div class="big">⚠️</div><'+h+'>'+esc(t("err_generic"))+'</'+h+'><p>'+esc(msg||t("try_later"))+'</p><button class="btn small" id="err-retry">'+esc(t("retry"))+'</button></div>';
}
function bindErrRetry(fn){ var b=$("#err-retry"); if(b) b.onclick=fn; }
function skeleton(n){
  var h="";
  for(var i=0;i<(n||2);i++){
    if(i===0) h+='<div class="skel" role="status" aria-busy="true"><span class="skel-text">'+esc(t("loading"))+'</span></div>';
    else h+='<div class="skel" aria-hidden="true"></div>';
  }
  return h;
}
function reqStar(){ return '<span class="req" aria-hidden="true">*</span><span class="sr-only"> ('+esc(t("required_word"))+')</span>'; }
function setFieldErr(inputId, errId, msg){
  var inp=document.getElementById(inputId), err=document.getElementById(errId);
  if(err) err.textContent=msg||"";
  if(inp) inp.setAttribute("aria-invalid", msg?"true":"false");
}
function badgeHtml(b){
  if(!b) return "";
  var map={bill:t("verified_bill"),id:t("verified_id"),name:t("verified_name")};
  var label=map[b]||b;
  return '<button type="button" class="chip good badge-btn" data-badge="'+esc(b)+'">✓ '+esc(label)+'</button>';
}
function badgesHtml(bill){
  var h="";
  var v=bill.verifications||bill.badges||{};
  var list=Array.isArray(v)?v:[];
  if(!Array.isArray(v)){ if(v.bill) list.push("bill"); if(v.id) list.push("id"); if(v.name) list.push("name"); }
  list.forEach(function(b){ h+=badgeHtml(b); });
  if(bill.pay_direct_verified||bill.payDirectVerified) h+='<span class="chip good">✓ '+esc(t("pay_direct_pill"))+'</span>';
  return h;
}
function statusChip(status){
  var map={pending_review:["warn",t("pending_review")],approved:["good",t("approved")],rejected:["bad",t("rejected")],completed:["good",t("completed")],changes_requested:["warn",t("changes_requested")],paused:["warn",t("paused")],under_investigation:["warn",t("paused")],draft:["",t("draft")],expired:["",t("expired")],removed:["bad",t("remove")]};
  var m=map[status]||["",status||""];
  return '<span class="chip '+m[0]+'">'+esc(m[1])+'</span>';
}
function progressHtml(bill){
  var total=bill.amount_minor||bill.amountMinor||0, got=bill.covered_minor||bill.coveredMinor||0;
  var pct=total>0?Math.min(100,Math.round(got/total*100)):0;
  return '<div class="progress"><i style="width:'+pct+'%"></i></div><p class="small">'+esc(money(got,bill.currency))+' '+esc(t("received"))+' · '+pct+'% · '+esc(money(Math.max(0,total-got),bill.currency))+' '+esc(t("remaining"))+'</p>';
}

/* ---------- state ---------- */
var S = {
  user:null, config:null, admin:false, booted:false,
  csrfToken:null, adminCsrf:null,
  country: (function(){ try{ return localStorage.getItem("sp_country")||null; }catch(e){ return null; } })(),
  feed:[], feedCursor:null, feedLoading:false, seen:{}, filters:loadFilters(),
  feedTotal:0, feedUpdatedAt:null, lastSwiped:null, lastSwipeAt:0, lastReshuffleAt:0,
  viewMode:"deck", searchQ:"", facetCounts:null,
  post:null, gift:null, basket:loadBasket(), blocked:loadBlocked(), saved:loadSaved(),
  leadersTab:"top_supporters", leadersPeriod:"all", leadersScope:"all",
  mybillsTab:"active", notifCache:[]
};
function defaultFilters(){ return {country:"own", categories:[], band:"", verifiedOnly:false, idVerifiedOnly:false, nameVerifiedOnly:false, verifiedFirst:false, payDirectOnly:false, charity:false, billShown:false, fundedOnly:false, posted:"any", city:"", near:"", radiusKm:50, amountMin:"", amountMax:"", askType:"", sort:"recommended"}; }
function loadFilters(){ try{ var f=JSON.parse(localStorage.getItem("sp_filters")||"null"); if(f){ var d=defaultFilters(); Object.keys(d).forEach(function(k){ if(f[k]===undefined) f[k]=d[k]; }); return f; } }catch(e){} return defaultFilters(); }
function saveFilters(){ try{ localStorage.setItem("sp_filters", JSON.stringify(S.filters)); }catch(e){} }
function loadBasket(){ try{ return JSON.parse(localStorage.getItem("sp_basket")||"[]"); }catch(e){ return []; } }
function saveBasket(){ try{ localStorage.setItem("sp_basket", JSON.stringify(S.basket)); }catch(e){} }
function loadBlocked(){ try{ return JSON.parse(localStorage.getItem("sp_blocked")||"[]"); }catch(e){ return []; } }
function saveBlocked(){ try{ localStorage.setItem("sp_blocked", JSON.stringify(S.blocked)); }catch(e){} }
function loadSeen(){ try{ S.seen=JSON.parse(localStorage.getItem("sp_seen")||"{}"); }catch(e){ S.seen={}; } }
function saveSeen(){ try{ localStorage.setItem("sp_seen", JSON.stringify(S.seen)); }catch(e){} }
loadSeen();
function loadSaved(){ try{ return JSON.parse(localStorage.getItem("sp_saved")||"[]"); }catch(e){ return []; } }
function saveSaved(){ try{ localStorage.setItem("sp_saved", JSON.stringify(S.saved)); updateSavedBadge(); }catch(e){} }
function isSaved(id){ return S.saved.some(function(s){ return String(s.id)===String(id); }); }
function toggleSaved(bill){
  var i=S.saved.findIndex(function(s){ return String(s.id)===String(bill.id); });
  if(i>=0){ S.saved.splice(i,1); }
  else { S.saved.unshift({id:bill.id, savedAt:Date.now(), title:bill.title||"", amountMinor:bill.amount_minor||bill.amountMinor||0, coveredMinor:bill.covered_minor||bill.coveredMinor||0, currency:bill.currency||"NPR", category:bill.category||"", expiresAt:bill.expiresAt||bill.expires_at||null, status:bill.status||"approved"}); }
  saveSaved();
  return i<0;
}
function updateSavedBadge(){
  var b=document.querySelector("[data-saved-badge]");
  if(b){ b.textContent=String(S.saved.length); b.hidden=S.saved.length===0; }
  var d=document.querySelector("[data-drafts-badge]");
  if(d){ var n=loadDrafts().length; d.textContent=String(n); d.hidden=n===0; }
}

/* ---------- phase 2 shared data ---------- */
// 21 bill types (items 55/146): OnlyBills' 21-type list adapted to
// Nepal/India. The app's 17 categories are the backbone; the four extra
// types (debt, wedding, funeral, festival) map to "Other" with a free-text
// description, replacing OnlyBills' UK-flavoured types (council tax,
// Christmas, nights out, birthdays).
var BILL_TYPES=[
  {key:"electricity", cat:"Electricity", icon:"⚡"},
  {key:"water", cat:"Water", icon:"💧"},
  {key:"internet", cat:"Internet", icon:"🌐"},
  {key:"education", cat:"Education", icon:"🎓"},
  {key:"medical", cat:"Medical expenses", icon:"🏥"},
  {key:"rent", cat:"Rent", icon:"🏠"},
  {key:"housing", cat:"Housing", icon:"🏡"},
  {key:"mobile", cat:"Mobile recharge", icon:"📱"},
  {key:"food", cat:"Food & essentials", icon:"🛒"},
  {key:"transport", cat:"Transportation", icon:"🚌"},
  {key:"family", cat:"Family expenses", icon:"👨‍👩‍👧‍👦"},
  {key:"emergency", cat:"Emergency expenses", icon:"🚨"},
  {key:"business", cat:"Small business", icon:"🏪"},
  {key:"vet", cat:"Veterinary", icon:"🐾"},
  {key:"government", cat:"Government fees", icon:"🏛️"},
  {key:"charity", cat:"Charity", icon:"💛"},
  {key:"debt", cat:"Other", icon:"💳"},
  {key:"wedding", cat:"Other", icon:"💍"},
  {key:"funeral", cat:"Other", icon:"🕯️"},
  {key:"festival", cat:"Other", icon:"🪔"},
  {key:"other", cat:"Other", icon:"🧾"}
];
function billTypeByKey(k){ return BILL_TYPES.find(function(x){ return x.key===k; })||null; }
function categoryIcon(cat){
  var m={"Electricity":"⚡","Water":"💧","Internet":"🌐","Education":"🎓","Medical expenses":"🏥","Rent":"🏠","Housing":"🏡","Mobile recharge":"📱","Food & essentials":"🛒","Transportation":"🚌","Family expenses":"👨‍👩‍👧‍👦","Emergency expenses":"🚨","Small business":"🏪","Veterinary":"🐾","Government fees":"🏛️","Charity":"💛","Other":"🧾"};
  return m[cat]||"🧾";
}
function askTypeOf(bill){
  if(bill.askType) return bill.askType;
  if(bill.charity) return "charity";
  if(bill.business) return "business";
  if(bill.dream) return "dream";
  return "bill";
}
function askTypeBadge(bill){
  var at=askTypeOf(bill);
  var map={bill:["🧾",t("ask_badge_bill")],dream:["✨",t("ask_badge_dream")],business:["🏪",t("ask_badge_business")],charity:["🎗️",t("ask_badge_charity")]};
  var m=map[at]||map.bill;
  return '<span class="chip">'+m[0]+' '+esc(m[1])+'</span>';
}
function daysLeftOf(bill){
  var exp=bill.expiresAt||bill.expires_at||null;
  if(!exp && bill.approvedAt) exp=new Date(new Date(bill.approvedAt).getTime()+30*86400000).toISOString();
  if(!exp) return null;
  return Math.ceil((new Date(exp).getTime()-Date.now())/86400000);
}
function expiryLabel(bill){
  var d=daysLeftOf(bill);
  if(d===null) return "";
  if(d<=0) return t("expiry_today");
  return t("expiry_countdown",{n:d});
}
function citiesList(){ return (S.config&&S.config.cities)||[]; }
function findCityClient(name){
  if(!name) return null;
  var n=String(name).trim().toLowerCase();
  var r=citiesList().find(function(c){ return c[0].toLowerCase()===n; });
  return r?{name:r[0],country:r[1],lat:r[2],lon:r[3]}:null;
}
function haversineKmClient(a,b){
  var R=6371, dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lon-a.lon)*Math.PI/180;
  var la1=a.lat*Math.PI/180, la2=b.lat*Math.PI/180;
  var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return 2*R*Math.asin(Math.sqrt(h));
}
function fmtClock(ms){ try{ return new Date(ms).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}); }catch(e){ return ""; } }
// Session streak (item 18): consecutive days the feed was opened.
function recordFeedVisit(){
  try{
    var today=new Date().toISOString().slice(0,10);
    var rec=JSON.parse(localStorage.getItem("sp_streak")||"null")||{last:"", count:0};
    if(rec.last===today) return rec.count;
    var y=new Date(Date.now()-86400000).toISOString().slice(0,10);
    rec.count=(rec.last===y)?rec.count+1:1;
    rec.last=today;
    localStorage.setItem("sp_streak", JSON.stringify(rec));
    return rec.count;
  }catch(e){ return 0; }
}
function getStreak(){ try{ return (JSON.parse(localStorage.getItem("sp_streak")||"null")||{}).count||0; }catch(e){ return 0; } }
// Multi-draft store (item 167). The legacy single draft (sp_post_draft) is
// migrated into the store on first read.
function loadDrafts(){
  try{
    var list=JSON.parse(localStorage.getItem("sp_drafts")||"null");
    if(Array.isArray(list)) return list;
    var legacy=JSON.parse(localStorage.getItem("sp_post_draft")||"null");
    if(legacy){ list=[{id:"legacy", updatedAt:Date.now(), data:legacy}]; localStorage.setItem("sp_drafts", JSON.stringify(list)); return list; }
  }catch(e){}
  return [];
}
function saveDrafts(list){ try{ localStorage.setItem("sp_drafts", JSON.stringify(list)); updateSavedBadge(); }catch(e){} }
function draftCompletion(d){
  var p=d||{};
  var fields=["title","category","amountRupees","story","city"];
  var done=fields.filter(function(k){ return p[k]; }).length;
  if(p.payouts&&p.payouts.length&&p.payouts[0].account) done++;
  return Math.round(done/6*100);
}
function upsertDraft(id, data){
  var list=loadDrafts();
  var i=list.findIndex(function(x){ return x.id===id; });
  var rec={id:id, updatedAt:Date.now(), data:data};
  if(i>=0) list[i]=rec; else list.unshift(rec);
  saveDrafts(list);
  return rec;
}

/* ---------- theme ---------- */
function applyTheme(){
  var pref="system"; try{ pref=localStorage.getItem("sp_theme")||"system"; }catch(e){}
  var dark = pref==="dark" || (pref==="system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark?"dark":"light");
}
applyTheme();

/* ---------- API client ---------- */
async function api(path, opts){
  opts=opts||{};
  var method=(opts.method||"GET").toUpperCase();
  var isWrite=method!=="GET"&&method!=="HEAD"&&method!=="OPTIONS";
  var isAdminPath=path.indexOf("/admin/")===0;
  var headers={"Content-Type":"application/json"};
  // CSRF synchronizer token (item 129): the user token for user paths,
  // the admin token for admin paths. Fetched at boot/login; refreshed
  // automatically once if the server rejects it.
  if(isWrite){
    var tok=isAdminPath?S.adminCsrf:S.csrfToken;
    if(tok) headers["X-CSRF-Token"]=tok;
  }
  var init={method:method, credentials:"include", headers:headers};
  if(opts.body!==undefined) init.body=JSON.stringify(opts.body);
  var res;
  try{ res=await fetch("/api"+path, init); }
  catch(e){ showOfflineBanner(false); var err=new Error(t("err_network")); err.code="NETWORK"; throw err; }
  var data=null;
  var text=await res.text();
  if(text){ try{ data=JSON.parse(text); }catch(e){ data={raw:text}; } }
  if(!res.ok){
    var code=(data&&data.error&&data.error.code)||("HTTP_"+res.status);
    if(res.status===403 && code==="CSRF_INVALID" && isWrite && !opts._csrfRetried){
      try{
        var fresh=await api(isAdminPath?"/admin/csrf":"/auth/csrf", {method:"GET"});
        if(fresh&&fresh.csrfToken){
          if(isAdminPath) S.adminCsrf=fresh.csrfToken; else S.csrfToken=fresh.csrfToken;
          opts._csrfRetried=true;
          return api(path, opts);
        }
      }catch(e){ /* fall through to the original error */ }
    }
    var msg=(data&&data.error&&data.error.message)||t("err_generic");
    var err2=new Error(msg); err2.code=code; err2.status=res.status; err2.data=data; throw err2;
  }
  return data;
}
async function uploadFile(file, kind){
  // kind FIRST: multer picks the destination dir from it, and fields sent
  // after the file part aren't parsed yet when the file stream starts.
  var fd=new FormData(); fd.append("kind", kind||"public_bill"); fd.append("file", file);
  var res;
  var upHeaders={};
  if(S.csrfToken) upHeaders["X-CSRF-Token"]=S.csrfToken;
  try{ res=await fetch("/api/uploads", {method:"POST", credentials:"include", headers:upHeaders, body:fd}); }
  catch(e){ showOfflineBanner(false); var err=new Error(t("err_network")); err.code="NETWORK"; throw err; }

  var data=null; try{ data=await res.json(); }catch(e){}
  if(!res.ok){ var e2=new Error((data&&data.error&&data.error.message)||t("upload_failed")); e2.code=(data&&data.error&&data.error.code)||"UPLOAD"; e2.status=res.status; throw e2; }
  return data;
}
function pickList(data, keys){
  if(Array.isArray(data)) return data;
  if(!data) return [];
  for(var i=0;i<keys.length;i++){ if(Array.isArray(data[keys[i]])) return data[keys[i]]; }
  if(Array.isArray(data.items)) return data.items;
  if(Array.isArray(data.rows)) return data.rows;
  if(Array.isArray(data.data)) return data.data;
  return [];
}
function feeSentence(){
  var mode=S.config&&S.config.feeMode;
  if(mode==="zero_fee_plus_tip") return t("fee_sentence_zero");
  return t("fee_sentence_supporter");
}
function feeConfig(){
  var c=S.config&&S.config.feeConfig;
  if(c && (c.NPR||c.INR)) return c;
  return {NPR:{flatMinor:16000,thresholdMinor:160000,percent:10,minMinor:16000},INR:{flatMinor:10000,thresholdMinor:100000,percent:10,minMinor:10000}};
}
function quoteLocal(amountMinor, currency, charity){
  var mode=S.config&&S.config.feeMode;
  if(mode==="zero_fee_plus_tip" || charity) return {feeMinor:0,totalMinor:amountMinor,feeMode:mode||"supporter_fee"};
  var cfg=feeConfig();
  var c=currency==="INR"?(cfg.INR||cfg.inr||{flatMinor:10000,thresholdMinor:100000,percent:10,minMinor:10000}):(cfg.NPR||cfg.npr||{flatMinor:16000,thresholdMinor:160000,percent:10,minMinor:16000});
  var pct=c.percent!=null?c.percent:(cfg.percent!=null?cfg.percent:10);
  var flat=c.flatMinor!=null?c.flatMinor:c.flat||0, thr=c.thresholdMinor!=null?c.thresholdMinor:c.threshold||0, mn=c.minMinor!=null?c.minMinor:c.min||0;
  var fee = amountMinor<=thr ? flat : Math.round(amountMinor*pct/100);
  fee=Math.max(fee, mn);
  return {feeMinor:fee,totalMinor:amountMinor+fee,feeMode:"supporter_fee"};
}

/* ---------- shell ---------- */
function setChrome(show){
  $("#topbar").hidden=!show;
  $("#dock").hidden=!show;
  $("#view").classList.toggle("no-chrome", !show);
  document.body.classList.toggle("has-chrome", show);
  if(show) updateTopbar();
}
function resetTopbar(){
  $("#avatar-initial").textContent="?";
  var b=$("#bell-badge"); b.hidden=true; b.textContent="0";
  $("#country-chip").hidden=true;
}
function updateTopbar(){
  var chip=$("#country-chip");
  var c=S.user?S.user.country:S.country;
  if(c){ chip.hidden=false; chip.textContent=flag(c)+" "+(countryCode(c)==="IN"?"₹ INR":"रू NPR"); }
  else chip.hidden=true;
  $("#avatar-initial").textContent=S.user?initials(S.user.display_name||S.user.displayName):"?";
  if(S.user) loadUnread();
  else { var b=$("#bell-badge"); b.hidden=true; b.textContent="0"; }
}
async function loadUnread(){
  var me=S.user&&S.user.id;
  try{
    var d=await api("/notifications");
    if(!S.user || S.user.id!==me) return; // user logged out / switched while loading
    var list=pickList(d,["notifications"]);
    var n=list.filter(function(x){ return !x.is_read && !x.isRead; }).length;
    var b=$("#bell-badge");
    if(n>0){ b.hidden=false; b.textContent=n>99?"99+":String(n); } else b.hidden=true;
  }catch(e){ /* bell stays quiet on failure */ }
}
function setActiveTab(tab){
  $all(".dock-tab").forEach(function(a){ a.classList.toggle("active", a.getAttribute("data-tab")===tab); });
}
function applyI18nStatic(){
  $all("[data-i18n]").forEach(function(n){ n.textContent=t(n.getAttribute("data-i18n")); });
}
/* Navigation token: every view() call bumps NAV and returns it. Async
   render callbacks capture the token before their await and bail if it
   changed — the user navigated away (or the view re-rendered), so a late
   response must never clobber the current view or touch elements that
   no longer exist. */
var NAV=0;
function view(html){ NAV++; $("#view").innerHTML=html; window.scrollTo(0,0); applyI18nStatic(); try{ $("#view").focus({preventScroll:true}); }catch(e){ try{ $("#view").focus(); }catch(e2){} } return NAV; }
function go(hash){ location.hash=hash; }
function needUser(){
  if(S.user) return true;
  openSheet('<h2>'+esc(t("welcome_back"))+'</h2><p>'+esc(t("need_profile"))+'</p><a class="btn" href="#/country">'+esc(t("get_started"))+'</a>');
  return false;
}
function crossBorderHtml(){
  return '<div class="notice warn"><strong>'+esc(t("cross_border_title"))+'</strong><p style="margin:6px 0 0">'+esc(t("cross_border_body"))+'</p><p class="legal" style="margin:6px 0 0">'+esc(t("legal_note"))+'</p></div>';
}
function demoHtml(){ return '<div class="demo">'+esc(t("demo_mode"))+'</div>'; }
function neverHoldsHtml(){ return '<p class="small" style="text-align:center">🔒 '+esc(t("never_holds"))+'</p>'; }
function feeSentenceHtml(){ return '<p class="small" style="text-align:center">'+esc(feeSentence())+'</p>'; }

/* badge explanation (delegated) */
document.addEventListener("click", function(e){
  var b=e.target.closest(".badge-btn");
  if(b){
    e.preventDefault(); e.stopPropagation();
    var k=b.getAttribute("data-badge");
    var what={bill:t("verify_bill_help"),id:t("verify_id_help"),name:t("verify_name_help")}[k]||"";
    openSheet('<h2>'+esc(t("badge_what"))+'</h2><p><strong>'+esc(b.textContent.trim())+'</strong></p><p>'+esc(what)+'</p><p class="small">'+esc(t("badge_checked"))+'</p><button class="btn secondary" onclick="document.getElementById(\'sheet-root\').innerHTML=\'\'">'+esc(t("close"))+'</button>');
  }
});

/* topbar buttons */
$("#bell-btn").addEventListener("click", function(){ go("#/notifications"); });
$("#avatar-btn").addEventListener("click", function(){
  if(!S.user){ go("#/country"); return; }
  openSheet('<h2>'+esc(S.user.display_name||S.user.displayName||"")+'</h2><p class="small">@'+esc(S.user.username||"")+' · '+esc(S.user.city||"")+'</p>'
    +'<div style="display:grid;gap:8px;margin-top:10px">'
    +'<a class="btn secondary" href="#/profile/'+encodeURIComponent(S.user.username||"")+'">'+esc(t("my_profile"))+'</a>'
    +'<a class="btn secondary" href="#/settings">'+esc(t("settings"))+'</a>'
    +'<a class="btn secondary" href="#/verify">'+esc(t("verify_centre"))+'</a>'
    +'<a class="btn secondary" href="#/help">'+esc(t("help_centre"))+'</a>'
    +'<a class="btn secondary" href="#/admin">'+esc(t("admin"))+'</a>'
    +'<button class="btn ghost" id="menu-logout">'+esc(t("logout"))+'</button></div>');
  $("#menu-logout").onclick=async function(){ closeSheets(); await doLogout(false); };
});
$("#theme-toggle").addEventListener("click", function(){
  var cur="system"; try{ cur=localStorage.getItem("sp_theme")||"system"; }catch(e){}
  var next=cur==="light"?"dark":cur==="dark"?"system":"light";
  try{ localStorage.setItem("sp_theme", next); }catch(e){}
  applyTheme(); toast(t("theme_changed"));
});
async function doLogout(all){
  try{ await api(all?"/auth/logout-all":"/auth/logout", {method:"POST"}); }catch(e){}
  S.user=null; S.csrfToken=null; resetTopbar(); toast(t("logged_out")); go("#/welcome");

}

/* ---------- payout validation (mirrors server rules) ---------- */
function validMobile(v){ return /^9[78]\d{8}$/.test(String(v||"").replace(/[\s-]/g,"")); }
function validUPI(v){ return /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(String(v||"").trim()); }
function validIFSC(v){ return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v||"").trim().toUpperCase()); }
function validatePayout(method, f){
  if(method==="esewa"||method==="khalti"){
    if(!validMobile(f.account)) return method==="esewa"?t("err_esewa"):t("err_khalti");
    if(!f.holder||f.holder.trim().length<2) return t("err_holder");
  } else if(method==="upi"){
    if(!validUPI(f.account)) return t("err_upi");
    if(!f.holder||f.holder.trim().length<2) return t("err_holder");
  } else if(method==="bank_in"){
    if(!/^\d{9,18}$/.test(String(f.account||"").trim())) return t("err_bank_ac");
    if(!validIFSC(f.ifsc)) return t("err_ifsc");
    if(!f.holder||f.holder.trim().length<2) return t("err_holder");
  } else if(method==="bank_np"||method==="connectips"){
    if(!/^\d{5,20}$/.test(String(f.account||"").trim())) return t("err_bank_ac");
    if(!f.bank||f.bank.trim().length<2) return t("err_bank_name");
    if(!f.holder||f.holder.trim().length<2) return t("err_holder");
  } else if(method==="payment_link"){
    if(!/^https:\/\//i.test(String(f.account||"").trim())) return t("err_required");
  } else if(method==="fonepay_qr"){
    if(!f.qrUrl) return t("err_required");
  }
  return null;
}
function payoutMethodsFor(country){
  if(countryCode(country)==="IN") return [
    {id:"upi", label:"UPI"},
    {id:"bank_in", label:"Bank transfer (India)"},
    {id:"payment_link", label:"Payment link"}
  ];
  return [
    {id:"esewa", label:"eSewa"},
    {id:"khalti", label:"Khalti"},
    {id:"connectips", label:"connectIPS"},
    {id:"bank_np", label:"Bank transfer (Nepal)"},
    {id:"fonepay_qr", label:"Fonepay QR"}
  ];
}
function maskedHint(method, account){
  var a=String(account||"");
  if(method==="upi"){ var parts=a.split("@"); return "UPI ····@"+(parts[1]||""); }
  return method+" ····"+a.slice(-4);
}

/* ---------- router ---------- */
var ROUTES = [
  {re:/^#\/splash$/, fn:renderSplash, chrome:false},
  {re:/^#\/welcome$/, fn:renderWelcome, chrome:false},
  {re:/^#\/country$/, fn:renderCountry, chrome:false},
  {re:/^#\/onboarding$/, fn:renderOnboarding, chrome:false},
  {re:/^#\/recover$/, fn:renderRecover, chrome:false},
  {re:/^#\/consent$/, fn:renderConsent, chrome:false},
  {re:/^#\/age-block$/, fn:renderAgeBlock, chrome:false},
  {re:/^#\/swipe$/, fn:renderSwipe, chrome:true, tab:"swipe"},
  {re:/^#\/saved$/, fn:renderSaved, chrome:true, tab:"saved"},
  {re:/^#\/category\/([^\/\?]+)$/, fn:renderCategory, chrome:true},
  {re:/^#\/browse-types$/, fn:renderBrowseTypes, chrome:true},
  {re:/^#\/drafts$/, fn:renderDrafts, chrome:true},
  {re:/^#\/expired$/, fn:renderExpired, chrome:true, tab:"mybills"},
  {re:/^#\/bill\/([^\/\?]+)$/, fn:renderBill, chrome:true},
  {re:/^#\/photo\/([^\/\?]+)$/, fn:renderPhoto, chrome:true},
  {re:/^#\/post$/, fn:renderPost, chrome:true, tab:"post"},
  {re:/^#\/leaders$/, fn:renderLeaders, chrome:true, tab:"leaders"},
  {re:/^#\/brands$/, fn:renderBrands, chrome:true, tab:"brands"},
  {re:/^#\/brand\/([^\/\?]+)$/, fn:renderBrand, chrome:true, tab:"brands"},
  {re:/^#\/brand-new$/, fn:renderBrandNew, chrome:true, tab:"brands"},
  {re:/^#\/auctions$/, fn:renderAuctions, chrome:true, tab:"brands"},
  {re:/^#\/auction\/([^\/\?]+)$/, fn:renderAuction, chrome:true, tab:"brands"},
  {re:/^#\/mybills$/, fn:renderMyBills, chrome:true, tab:"mybills"},
  {re:/^#\/profile\/([^\/\?]+)$/, fn:renderProfile, chrome:true},
  {re:/^#\/settings$/, fn:renderSettings, chrome:true},
  {re:/^#\/help$/, fn:renderHelp, chrome:true},
  {re:/^#\/notifications$/, fn:renderNotifications, chrome:true},
  {re:/^#\/verify$/, fn:renderVerify, chrome:true},
  {re:/^#\/gift\/([^\/\?]+)$/, fn:renderGift, chrome:true},
  {re:/^#\/founder-tip$/, fn:renderFounderTip, chrome:true},
  {re:/^#\/admin$/, fn:renderAdminLogin, chrome:true},
  {re:/^#\/admin\/dashboard$/, fn:renderAdminDashboard, chrome:true},
  {re:/^#\/admin\/queue$/, fn:renderAdminQueue, chrome:true},
  {re:/^#\/admin\/users$/, fn:renderAdminUsers, chrome:true},
  {re:/^#\/admin\/verifications$/, fn:renderAdminVerifications, chrome:true},
  {re:/^#\/admin\/reports$/, fn:renderAdminReports, chrome:true},
  {re:/^#\/admin\/fees$/, fn:renderAdminFees, chrome:true},
  {re:/^#\/admin\/audit$/, fn:renderAdminAudit, chrome:true}
];
function queryParams(){
  var h=location.hash; var q={};
  var i=h.indexOf("?");
  if(i<0) return q;
  h.slice(i+1).split("&").forEach(function(p){ var kv=p.split("="); if(kv[0]) q[decodeURIComponent(kv[0])]=decodeURIComponent(kv[1]||""); });
  return q;
}
function route(){
  closeSheets();
  var h=location.hash||"#/splash";
  var path=h.split("?")[0];
  // Consent re-acceptance (item 492): a signed-in user on an old Terms /
  // Privacy version must re-accept before using the app (they may still
  // read the Help Centre to see what changed).
  if(S.user && S.user.consentCurrent===false && path!=="#/consent" && path!=="#/help" && path!=="#/splash"){
    go("#/consent");
    return;
  }
  for(var i=0;i<ROUTES.length;i++){
    var m=path.match(ROUTES[i].re);
    if(m){
      setChrome(!!ROUTES[i].chrome);
      setActiveTab(ROUTES[i].tab||"");
      try{ ROUTES[i].fn(m[1], queryParams()); }catch(e){ console.error(e); view(errBox(e.message, "h1")); bindErrRetry(route); }
      return;
    }
  }
  setChrome(true);
  setActiveTab("");
  renderNotFound();
}
function renderNotFound(){
  view('<div class="center-page"><div class="logo-big"><img src="logo.svg" alt="" width="96" height="96"></div><h1>'+esc(t("not_found_title"))+'</h1><p>'+esc(t("not_found_body"))+'</p><div style="width:100%;max-width:360px;display:grid;gap:10px;margin-top:10px"><a class="btn" href="#/swipe">'+esc(t("go_swipe"))+'</a><a class="btn secondary" href="#/help">'+esc(t("help_centre"))+'</a></div></div>');
}
window.addEventListener("hashchange", route);

/* ---------- splash / welcome / country / onboarding ---------- */
function renderSplash(){
  view('<div class="center-page"><div class="logo-big"><img src="logo.svg" alt="" width="96" height="96"></div><h1>Sahay Pay</h1><p>'+esc(t("splash_tag"))+'</p><p class="small">'+esc(t("splash_loading"))+'</p></div>');
  setTimeout(function(){
    if(location.hash.split("?")[0]!=="#/splash") return;
    if(S.user) go("#/swipe");
    else {
      var seen=false; try{ seen=localStorage.getItem("sp_welcomed")==="1"; }catch(e){}
      go(seen?"#/country":"#/welcome");
    }
  }, 1400);
}
function renderWelcome(){
  var slides=[
    {ic:"🧾", title:t("welcome_s1_t"), body:t("welcome_s1_b")},
    {ic:"💙", title:t("welcome_s2_t"), body:t("welcome_s2_b")},
    {ic:"✅", title:t("welcome_s3_t"), body:t("welcome_s3_b")}
  ];
  var idx=0;
  function draw(){
    var s=slides[idx];
    view('<div class="center-page"><div class="slide-ic">'+s.ic+'</div><h1>'+esc(s.title)+'</h1><p>'+esc(s.body)+'</p>'
      +'<div class="step-dots">'+slides.map(function(_,i){ return '<i class="'+(i===idx?"on":"")+'"></i>'; }).join("")+'</div>'
      +'<div style="width:100%;max-width:360px;display:grid;gap:10px;margin-top:14px">'
      +'<button class="btn" id="w-next">'+esc(idx<2?t("next"):t("get_started"))+'</button>'
      +'<button class="btn ghost" id="w-skip">'+esc(t("skip"))+'</button></div>'
      +'<p class="small" style="margin-top:12px"><a href="#/recover" id="w-recover">'+esc(t("returning_user"))+'</a></p>'
      +'<p class="small">'+esc(t("welcome_slide_hint"))+'</p></div>');
    $("#w-next").onclick=function(){ if(idx<2){ idx++; draw(); } else finish(); };
    $("#w-skip").onclick=finish;
  }
  function finish(){ try{ localStorage.setItem("sp_welcomed","1"); }catch(e){} go("#/country"); }
  draw();
}
function renderCountry(){
  var sel=S.country||(S.user?S.user.country:null);
  view('<div style="max-width:480px;margin:0 auto"><h1>'+esc(t("choose_country"))+'</h1><p>'+esc(t("country_hint"))+'</p>'
    +'<button type="button" class="card country-card'+(sel==="NP"?" on":"")+'" data-c="NP"><span class="flag">🇳🇵</span><span><strong>'+esc(t("nepal"))+' — नेपाल</strong><br><span class="small">'+esc(t("country_np_desc"))+'</span></span></button>'
    +'<button type="button" class="card country-card'+(sel==="IN"?" on":"")+'" data-c="IN"><span class="flag">🇮🇳</span><span><strong>'+esc(t("india"))+' — भारत</strong><br><span class="small">'+esc(t("country_in_desc"))+'</span></span></button>'
    +'<button class="btn" id="c-next" '+(sel?"":"disabled")+'>'+esc(t("continue_btn"))+'</button>'
    +'<p class="small" style="text-align:center;margin-top:12px"><a href="#/recover">'+esc(t("returning_user"))+'</a></p>'
    +'<p class="small" style="text-align:center;margin-top:12px"><a href="#/help">'+esc(t("help_centre"))+'</a> · <a href="#/admin">'+esc(t("admin"))+'</a></p></div>');
  $all(".country-card").forEach(function(b){
    b.onclick=function(){
      S.country=b.getAttribute("data-c");
      try{ localStorage.setItem("sp_country", S.country); }catch(e){}
      $all(".country-card").forEach(function(x){ x.classList.toggle("on", x===b); });
      $("#c-next").disabled=false;
    };
  });
  $("#c-next").onclick=function(){ go(S.user?"#/swipe":"#/onboarding"); };
}
function renderOnboarding(){
  var country=S.country||"NP";
  var lang=I.getLang();
  view('<div style="max-width:520px;margin:0 auto"><h1>'+esc(t("onboarding_title"))+'</h1><p>'+esc(t("onboarding_sub"))+'</p>'
    +'<div class="notice info">'+esc(t("consent_notice"))+'</div>'
    +'<p class="small">'+esc(t("required_note"))+'</p>'
    +'<form id="ob-form" class="card" style="margin-top:12px">'
    +'<label for="ob-name">'+esc(t("q_name"))+' '+reqStar()+'</label><input id="ob-name" maxlength="60" placeholder="'+esc(t("name_ph"))+'" autocomplete="name" aria-required="true" aria-describedby="e-name"><div class="field-err" id="e-name" role="alert"></div>'
    +'<label for="ob-age">'+esc(t("q_age"))+' '+reqStar()+' <span class="small muted">'+esc(t("age_hint"))+'</span></label><input id="ob-age" type="number" inputmode="numeric" min="1" max="120" placeholder="25" aria-required="true" aria-describedby="e-age"><div class="field-err" id="e-age" role="alert"></div>'
    +'<label>'+esc(t("country"))+'</label><div class="seg"><button type="button" data-c="NP" class="'+(country==="NP"?"on":"")+'">🇳🇵 '+esc(t("nepal"))+'</button><button type="button" data-c="IN" class="'+(country==="IN"?"on":"")+'">🇮🇳 '+esc(t("india"))+'</button></div>'
    +'<label for="ob-city">'+esc(t("q_city"))+' '+reqStar()+'</label><input id="ob-city" maxlength="80" placeholder="'+esc(t("city_ph"))+'" autocomplete="address-level2" aria-required="true" aria-describedby="e-city"><div class="field-err" id="e-city" role="alert"></div>'
    +'<label for="ob-about">'+esc(t("q_about"))+' '+esc(t("q_about_opt"))+'</label><textarea id="ob-about" maxlength="500" placeholder="'+esc(t("about_ph"))+'"></textarea><div class="small muted" style="text-align:right"><span id="ob-about-n">0</span>/500</div>'
    +'<label>'+esc(t("q_lang"))+'</label><div class="seg" id="ob-lang"><button type="button" data-l="en" class="'+(lang==="en"?"on":"")+'">English</button><button type="button" data-l="ne" class="'+(lang==="ne"?"on":"")+'">नेपाली</button><button type="button" data-l="hi" class="'+(lang==="hi"?"on":"")+'">हिन्दी</button></div>'
    +'<label for="ob-photo">'+esc(t("q_photo"))+'</label><input id="ob-photo" type="file" accept="image/jpeg,image/png,image/webp"><p class="small">'+esc(t("photo_skip"))+'</p>'
    +'<label class="check-row"><input type="checkbox" id="ob-c1"><span>'+esc(t("consent_age"))+'</span></label>'
    +'<label class="check-row"><input type="checkbox" id="ob-c2"><span>'+esc(t("consent_terms_only"))+' <a href="#/help?topic=terms">'+esc(t("terms"))+'</a></span></label>'
    +'<label class="check-row"><input type="checkbox" id="ob-c3"><span>'+esc(t("consent_privacy_only"))+' <a href="#/help?topic=privacy">'+esc(t("privacy"))+'</a></span></label>'
    +'<div class="field-err" id="e-consent" role="alert"></div>'

    +'<button class="btn" type="submit" id="ob-submit">'+esc(t("create_profile"))+'</button>'
    +'<p class="small" style="text-align:center;margin-top:10px">'+esc(t("username_generated"))+'</p>'
    +'</form></div>');
  var chosenCountry=country, chosenLang=lang;
  $all("#ob-form .seg button[data-c]").forEach(function(b){ b.onclick=function(){ chosenCountry=b.getAttribute("data-c"); S.country=chosenCountry; try{ localStorage.setItem("sp_country", chosenCountry); }catch(e){} $all("#ob-form .seg button[data-c]").forEach(function(x){ x.classList.toggle("on", x===b); }); }; });
  $all("#ob-lang button").forEach(function(b){ b.onclick=function(){ chosenLang=b.getAttribute("data-l"); I.setLang(chosenLang); applyI18nStatic(); $all("#ob-lang button").forEach(function(x){ x.classList.toggle("on", x===b); }); }; });
  $("#ob-about").addEventListener("input", function(){ $("#ob-about-n").textContent=String($("#ob-about").value.length); });
  $("#ob-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var name=$("#ob-name").value.trim(), age=parseInt($("#ob-age").value,10), city=$("#ob-city").value.trim(), about=$("#ob-about").value.trim();
    var ok=true;
    setFieldErr("ob-name","e-name",""); setFieldErr("ob-age","e-age",""); setFieldErr("ob-city","e-city",""); $("#e-consent").textContent="";
    if(name.length<2||name.length>60){ setFieldErr("ob-name","e-name",t("name_short")); ok=false; }
    if(isNaN(age)||age<1||age>120){ setFieldErr("ob-age","e-age",t("age_invalid")); ok=false; }
    if(!city){ setFieldErr("ob-city","e-city",t("city_required")); ok=false; }
    if(!$("#ob-c1").checked||!$("#ob-c2").checked||!$("#ob-c3").checked){ $("#e-consent").textContent=t("consent_both_required"); ok=false; }

    if(!ok) return;
    if(age<18){ go("#/age-block"); return; }
    var btn=$("#ob-submit"); btn.disabled=true; btn.textContent=t("loading");
    var op=NAV;
    try{
      var photoUrl=null;
      var f=$("#ob-photo").files[0];
      if(f){
        if(f.size>5*1024*1024) throw new Error(t("file_too_big"));
        var up=await uploadFile(f, "avatar");
        photoUrl=up.url||up.fileUrl||up.path||null;
      }
      var payload={displayName:name, age:age, country:chosenCountry, city:city, about:about, language:chosenLang, termsAccepted:true, privacyAccepted:true};
      if(photoUrl) payload.photoUrl=photoUrl;
      var res=await api("/auth/onboard", {method:"POST", body:payload});
      S.user=res.user||res;
      if(res.csrfToken) S.csrfToken=res.csrfToken;
      try{ localStorage.setItem("sp_lang", chosenLang); }catch(e){}
      if(op!==NAV) return; // navigated away mid-submit; account exists, no clobber
      // Recovery code: shown ONCE, here only. The server stores only a
      // hash, so this screen is the only time the code ever exists.
      var rc=res.recoveryCode||"";
      var rcHtml="";
      if(rc){
        rcHtml='<div class="card" style="max-width:420px;margin-top:14px"><h3>'+esc(t("recovery_code_title"))+'</h3>'
          +'<p class="small">'+esc(t("recovery_code_body"))+'</p>'
          +'<p id="rc-code" style="font-size:22px;font-weight:700;letter-spacing:2px;text-align:center;margin:12px 0;word-break:break-all">'+esc(rc)+'</p>'
          +'<button class="btn secondary" id="rc-copy">'+esc(t("recovery_code_copy"))+'</button></div>';
      }
      view('<div class="center-page"><div class="slide-ic">🎉</div><h1>'+esc(t("youre_in"))+'</h1><p>'+esc(t("youre_in_body"))+'</p>'+rcHtml+'<button class="btn" id="in-go" style="max-width:360px;margin-top:14px">'+esc(t("start_swiping"))+'</button></div>');
      if(rc){
        $("#rc-copy").onclick=function(){
          var done=function(){ toast(t("recovery_code_copied")); };
          if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(rc).then(done, function(){ toast(rc, false); }); }
          else { try{ var ta=document.createElement("textarea"); ta.value=rc; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); done(); }catch(e){ toast(rc, false); } }
        };
      }

      $("#in-go").onclick=function(){ go("#/swipe"); };
    }catch(err){
      if(op!==NAV) return;
      btn.disabled=false; btn.textContent=t("create_profile");
      if(err.status===403 && (err.code==="AGE_BLOCK"||/18/.test(err.message))){ go("#/age-block"); return; }
      toast(err.message||t("err_generic"), true);
    }
  });
}
function renderAgeBlock(){
  view('<div class="center-page"><div class="slide-ic">🔞</div><h1>'+esc(t("age_block_title"))+'</h1><p>'+esc(t("age_block_body"))+'</p><a class="btn" style="max-width:360px" href="#/welcome">'+esc(t("back_to_welcome"))+'</a></div>');
}
/* ---------- account recovery (no email, no password — recovery code only) ---------- */
function renderRecover(){
  if(S.user){ go("#/swipe"); return; }
  view('<div style="max-width:480px;margin:0 auto"><h1>'+esc(t("recover_title"))+'</h1><p>'+esc(t("recover_body"))+'</p>'
    +'<form id="rc-form" class="card" style="margin-top:12px">'
    +'<label>'+esc(t("recover_code_label"))+'</label><input id="rc-input" maxlength="19" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" style="letter-spacing:2px;text-transform:uppercase">'
    +'<div class="field-err" id="rc-err"></div>'
    +'<button class="btn" type="submit" id="rc-submit">'+esc(t("recover_btn"))+'</button>'
    +'<p class="small" style="text-align:center;margin-top:10px"><a href="#/welcome">'+esc(t("back_to_welcome"))+'</a></p>'
    +'</form></div>');
  $("#rc-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var code=$("#rc-input").value.trim();
    $("#rc-err").textContent="";
    if(code.replace(/[^A-Za-z0-9]/g,"").length!==16){ $("#rc-err").textContent=t("recover_invalid"); return; }
    var btn=$("#rc-submit"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var res=await api("/auth/recover", {method:"POST", body:{code:code}});
      S.user=res.user||null;
      if(res.csrfToken) S.csrfToken=res.csrfToken;
      if(S.user&&S.user.language) I.setLang(S.user.language);
      if(S.user&&S.user.country) S.country=countryCode(S.user.country);
      toast(t("welcome_back"));
      go("#/swipe");
    }catch(err){
      btn.disabled=false; btn.textContent=t("recover_btn");
      $("#rc-err").textContent=err.message||t("err_generic");
    }
  });
}
/* ---------- consent re-acceptance (Terms/Privacy version bump) ---------- */
function renderConsent(){
  if(!S.user){ go("#/welcome"); return; }
  view('<div style="max-width:520px;margin:0 auto"><h1>'+esc(t("consent_update_title"))+'</h1><p>'+esc(t("consent_update_body"))+'</p>'
    +'<form id="cn-form" class="card" style="margin-top:12px">'
    +'<label class="check-row"><input type="checkbox" id="cn-c1"><span>'+esc(t("consent_terms_only"))+' <a href="#/help?topic=terms">'+esc(t("terms"))+'</a></span></label>'
    +'<label class="check-row"><input type="checkbox" id="cn-c2"><span>'+esc(t("consent_privacy_only"))+' <a href="#/help?topic=privacy">'+esc(t("privacy"))+'</a></span></label>'
    +'<div class="field-err" id="cn-err"></div>'
    +'<button class="btn" type="submit" id="cn-submit">'+esc(t("consent_accept_btn"))+'</button>'
    +'</form></div>');
  $("#cn-form").addEventListener("submit", async function(e){
    e.preventDefault();
    if(!$("#cn-c1").checked||!$("#cn-c2").checked){ $("#cn-err").textContent=t("consent_both_required"); return; }
    var btn=$("#cn-submit"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var res=await api("/auth/re-consent", {method:"POST", body:{termsAccepted:true, privacyAccepted:true}});
      if(res.user) S.user=res.user;
      else if(S.user) S.user.consentCurrent=true;
      toast(t("saved"));
      go("#/swipe");
    }catch(err){
      btn.disabled=false; btn.textContent=t("consent_accept_btn");
      $("#cn-err").textContent=err.message||t("err_generic");
    }
  });
}
/* ---------- maintenance state (kill switch on) ---------- */
function renderMaintenance(message){
  view('<div class="center-page"><div class="slide-ic">🔧</div><h1>'+esc(t("maintenance_title"))+'</h1><p>'+esc(message||t("maintenance_body"))+'</p><button class="btn" id="mt-retry" style="max-width:360px">'+esc(t("maintenance_retry"))+'</button></div>');
  $("#mt-retry").onclick=function(){ location.reload(); };
}

/* ---------- swipe feed ---------- */
function feedQuery(){
  var f=S.filters, p=new URLSearchParams();
  p.set("sort", f.sort||"recommended");
  var cc = f.country==="own" ? (S.user?countryCode(S.user.country):(S.country||"")) : (f.country==="all"?"":f.country);
  if(cc) p.set("country", cc);
  if(f.categories.length) p.set("category", f.categories.join(","));
  if(f.band) p.set("amountBand", f.band);
  if(f.amountMin) p.set("amountMin", f.amountMin);
  if(f.amountMax) p.set("amountMax", f.amountMax);
  if(f.verifiedOnly) p.set("verified","1");
  if(f.idVerifiedOnly) p.set("idVerified","1");
  if(f.nameVerifiedOnly) p.set("nameVerified","1");
  if(f.verifiedFirst) p.set("verifiedFirst","1");
  if(f.payDirectOnly) p.set("payDirect","1");
  if(f.charity) p.set("charity","1");
  if(f.askType) p.set("askType", f.askType);
  if(f.billShown) p.set("bill_shown","1");
  if(f.fundedOnly) p.set("fundedOnly","1");
  if(f.posted && f.posted!=="any") p.set("posted", f.posted);
  if(f.city) p.set("city", f.city);
  if(f.near) { p.set("near", f.near); p.set("radiusKm", f.radiusKm||50); }
  if(S.user&&S.user.city) p.set("homeCity", S.user.city);
  if(S.searchQ) p.set("q", S.searchQ);
  var seenIds=Object.keys(S.seen);
  if(seenIds.length) p.set("seen", seenIds.join(","));
  p.set("limit","20");
  return p.toString();
}
async function loadFeed(reset){
  if(reset){ S.feed=[]; S.feedCursor=null; }
  if(S.feedLoading) return;
  S.feedLoading=true;
  try{
    var q=feedQuery();
    if(S.feedCursor) q+="&cursor="+encodeURIComponent(S.feedCursor);
    var d=await api("/feed?"+q);
    var list=pickList(d,["bills","feed"]);
    list=list.filter(function(b){ return !S.seen[b.id]; });
    S.feed=S.feed.concat(list);
    S.feedTotal=d.total!=null?d.total:S.feed.length;
    S.feedUpdatedAt=Date.now();
    S.feedCursor=d.cursor||d.nextCursor||null;
  }catch(e){ throw e; }
  finally{ S.feedLoading=false; }
}
async function loadFacetCounts(){
  try{
    var f=S.filters, p=new URLSearchParams();
    var cc = f.country==="own" ? (S.user?countryCode(S.user.country):(S.country||"")) : (f.country==="all"?"":f.country);
    if(cc) p.set("country", cc);
    if(f.city) p.set("city", f.city);
    if(f.posted && f.posted!=="any") p.set("posted", f.posted);
    S.facetCounts=await api("/feed/counts?"+p.toString());
  }catch(e){ S.facetCounts=null; }
  return S.facetCounts;
}
function swipeCardHtml(bill, pos, opts){
  opts=opts||{};
  var user=bill.user||bill.poster||{};
  var name=bill.anonymous? t("anonymous") : (user.display_name||user.displayName||bill.display_name||bill.displayName||bill.poster_name||bill.username||"");
  var uname=user.username||bill.username||"";
  var photo=bill.photo_url||bill.photoUrl||bill.public_photo_url||"";
  var story=bill.story||"";
  var cur=bill.currency||curOf(bill.country);
  var depth=pos===0?"":(pos===1?"transform:scale(.96) translateY(10px);opacity:.85":pos===2?"transform:scale(.92) translateY(20px);opacity:.6":"display:none");
  var why=bill.whySeeing? {verified:t("why_verified"),same_country:t("why_same_country"),same_city:t("why_same_city"),recent:t("why_recent"),few_supporters:t("why_few_supporters"),new_poster:t("why_new_poster"),stale:t("why_stale")}[bill.whySeeing] : "";
  var exp=expiryLabel(bill);
  var dist=bill.distanceKm!=null ? (bill.distanceKm===0? t("distance_same_city") : t("distance_km",{n:bill.distanceKm})) : "";
  var saved=isSaved(bill.id);
  var front='<div class="flip-face flip-front" style="display:flex;flex-direction:column;flex:1;min-height:0">'
    +'<div class="overlay-tag left">✕ '+esc(t("skip"))+'</div><div class="overlay-tag right">✓ '+esc(t("help_btn"))+'</div>'
    +'<div class="photo" data-act="photo">'+(photo?'<img src="'+esc(photo)+'" alt="'+esc(t("bill_photo_alt"))+'" loading="lazy">':'<span>🧾</span>')+'</div>'
    +'<div class="body"><div class="name-row"><div class="avatar" data-act="profile">'+(user.photo_url||user.photoUrl?'<img src="'+esc(user.photo_url||user.photoUrl)+'" alt="">':esc(initials(name)))+'</div>'
    +'<div style="flex:1;min-width:0"><strong data-act="profile" style="cursor:pointer">'+esc(name)+'</strong><div class="small">'+flag(bill.country)+' '+esc(bill.city||"")+' · '+esc(timeAgo(bill.created_at||bill.createdAt))+(dist?' · '+esc(dist):"")+'</div></div>'
    +'<span class="chip">'+categoryIcon(bill.category)+' '+esc(bill.category||"")+'</span></div>'
    +(opts.firstOfDay?'<p class="small" style="margin:6px 0 0">⭐ '+esc(t("first_card_today"))+'</p>':"")
    +'<h2 style="margin:10px 0 4px">'+esc(bill.title||"")+'</h2>'
    +'<p style="margin:4px 0"><span class="money" style="font-size:20px;font-weight:800;color:var(--ink)">'+esc(money(bill.amount_minor||bill.amountMinor||0, cur))+'</span>'
    +(bill.company? ' <span class="small">· '+esc(bill.company)+'</span>':"")+'</p>'
    +'<p>'+esc(story.length>180?story.slice(0,180)+"…":story)+' '+(story.length>180?'<a href="#/bill/'+encodeURIComponent(bill.id)+'">…'+esc(t("more"))+'</a>':"")+'</p>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">'+badgesHtml(bill)+askTypeBadge(bill)
    +(bill.charity?'<span class="chip">💛 '+esc(t("charity_only"))+'</span>':"")
    +((bill.posterApprovedCount!=null&&bill.posterApprovedCount<=1)?'<span class="chip">🌱 '+esc(t("why_new_poster"))+'</span>':"")
    +((bill.supporterCount!=null&&bill.supporterCount<=1)?'<span class="chip">🤲 '+esc(t("why_few_supporters"))+'</span>':"")
    +(exp?'<span class="chip">⏳ '+esc(exp)+'</span>':"")
    +(bill.payout_hint||bill.payoutHint?'<span class="chip">'+esc(bill.payout_hint||bill.payoutHint)+'</span>':"")+'</div>'
    + progressHtml(bill)
    +(why?'<p class="small muted">💡 '+esc(t("why_seeing"))+' '+esc(why)+'</p>':"")
    +'<p class="small muted">'+esc(t("tap_photo"))+'</p>'
    +'<p class="small" style="margin-top:6px">🆘 '+esc(t("support_banner"))+' <a href="#/help?topic=safety">'+esc(t("support_banner_link"))+'</a></p>'
    +'<div style="display:flex;gap:6px;margin-top:8px"><button type="button" class="btn secondary small" data-act="save" aria-pressed="'+(saved?"true":"false")+'">'+(saved?"🔖 "+esc(t("saved_bill")):"🔖 "+esc(t("save_bill")))+'</button>'
    +'<button type="button" class="btn secondary small" data-act="flip">🔄 '+esc(t("flip_for_story"))+'</button>'
    +'<button type="button" class="btn secondary small" data-act="report">🚩 '+esc(t("report"))+'</button></div>'
    +'</div></div>';
  var back='<div class="flip-face flip-back"><h2>'+esc(bill.title||"")+'</h2>'
    +'<p>'+esc(story)+'</p>'
    +(bill.details?'<p>'+esc(bill.details)+'</p>':"")
    +(bill.notPaidConsequence||bill.not_paid_consequence?'<p><strong>'+esc(t("not_paid_label"))+'</strong><br>'+esc(bill.notPaidConsequence||bill.not_paid_consequence)+'</p>':"")
    +(bill.triedToPay||bill.tried_to_pay?'<p><strong>'+esc(t("tried_pay_label"))+'</strong><br>'+esc(bill.triedToPay||bill.tried_to_pay)+'</p>':"")
    +(bill.moneyMeans||bill.money_means?'<p><strong>'+esc(t("money_means_label"))+'</strong><br>'+esc(bill.moneyMeans||bill.money_means)+'</p>':"")
    +(why?'<p class="small muted">💡 '+esc(t("why_seeing"))+' '+esc(why)+'</p>':"")
    +'<div style="display:flex;gap:6px;margin-top:10px"><a class="btn small" href="#/bill/'+encodeURIComponent(bill.id)+'">'+esc(t("view_bill"))+'</a>'
    +'<button type="button" class="btn secondary small" data-act="flip">↩ '+esc(t("flip_back"))+'</button></div></div>';
  return '<article class="swipe-card" data-id="'+esc(bill.id)+'" style="'+depth+'" data-pos="'+pos+'"><div class="flip-wrap">'+front+back+'</div></article>';
}
function listRowHtml(bill){
  var cur=bill.currency||curOf(bill.country);
  var photo=bill.photo_url||bill.photoUrl||"";
  return '<a class="card row-card" href="#/bill/'+encodeURIComponent(bill.id)+'">'
    +'<div class="avatar" style="width:52px;height:52px;font-size:22px">'+(photo?'<img src="'+esc(photo)+'" alt="">':categoryIcon(bill.category))+'</div>'
    +'<div class="grow"><div class="t">'+esc(bill.title||"")+'</div>'
    +'<div class="s">'+esc(money(bill.amount_minor||bill.amountMinor||0,cur))+' · '+esc(bill.category||"")+' · '+flag(bill.country)+' '+esc(bill.city||"")+'</div>'
    +progressHtml(bill)+'</div><span>›</span></a>';
}
function filterSummaryText(){
  var f=S.filters, parts=[];
  if(f.categories.length) parts.push(f.categories.join(", "));
  if(f.band) parts.push(t("band_"+f.band)||f.band);
  if(f.verifiedOnly) parts.push(t("verified_only"));
  if(f.idVerifiedOnly) parts.push(t("id_verified_chip"));
  if(f.nameVerifiedOnly) parts.push(t("name_verified_chip"));
  if(f.charity) parts.push(t("charity_only"));
  if(f.askType) parts.push(t("ask_type_"+f.askType)||f.askType);
  if(f.billShown) parts.push(t("bill_shown"));
  if(f.fundedOnly) parts.push(t("fully_funded_only"));
  if(f.city) parts.push(f.city);
  if(f.near) parts.push(t("near_me_radius",{n:f.radiusKm||50}));
  if(f.posted&&f.posted!=="any") parts.push(f.posted==="today"?t("today"):f.posted==="week"?t("this_week"):t("this_month"));
  if(S.searchQ) parts.push('“'+S.searchQ+'”');
  return parts.length? parts.join(" · ") : t("filter_summary_none");
}
function recentSearches(){
  try{ return JSON.parse(localStorage.getItem("sp_recent_search")||"[]"); }catch(e){ return []; }
}
function pushRecentSearch(q){
  try{
    var list=recentSearches().filter(function(x){ return x!==q; });
    list.unshift(q); list=list.slice(0,8);
    localStorage.setItem("sp_recent_search", JSON.stringify(list));
  }catch(e){}
}
function renderSwipe(){
  var streak=recordFeedVisit();
  view('<h1>'+esc(t("feed_title"))+'</h1><p>'+esc(t("feed_sub"))+'</p>'
    +'<div id="feed-meta" class="small muted" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px"></div>'
    +'<div style="position:relative;margin-bottom:10px"><label class="sr-only" for="feed-search">'+esc(t("search"))+'</label><input id="feed-search" type="search" value="'+esc(S.searchQ)+'" placeholder="'+esc(t("search_ph"))+'" autocomplete="off"><div id="feed-suggest"></div></div>'
    +'<div id="search-helpers" style="margin-bottom:8px"></div>'
    +'<div class="seg" id="ask-switch" style="margin-bottom:10px"></div>'
    +'<div id="filter-summary" class="small" style="margin-bottom:8px"></div>'
    +'<div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn secondary small" id="f-open" style="flex:1">🔍 '+esc(t("filters"))+'</button>'
    +'<button class="btn secondary small" id="f-refresh" style="flex:1">🔁 '+esc(t("refresh"))+'</button>'
    +'<button class="btn secondary small" id="f-view" style="flex:1">'+(S.viewMode==="list"?"🃏 "+esc(t("deck_view")):"☰ "+esc(t("list_view")))+'</button></div>'
    +'<div id="deck-wrap">'+skeleton(1)+'</div>'
    +'<div class="controls" id="swipe-controls" hidden>'
    +'<button class="ctl skip" id="c-skip" aria-label="'+esc(t("skip"))+'">✕</button>'
    +'<button class="ctl help" id="c-help" aria-label="'+esc(t("help_btn"))+'">💙</button>'
    +'<a class="ctl" href="#/leaders" aria-label="'+esc(t("tab_leaders"))+'">🏆</a>'
    +'<button class="ctl" id="c-reshuffle" aria-label="'+esc(t("reshuffle"))+'">🔁</button>'
    +'<button class="ctl" id="c-undo" aria-label="'+esc(t("undo_swipe"))+'">↩</button></div>'
    +'<p class="small muted" style="text-align:center" id="swipe-hint">'+esc(t("swipe_hint"))+'</p>'
    +'<div id="feed-extra"></div>');
  // Saved-bill notices (items 81/82): checked on feed load, in-app only.
  checkSavedNotices();
  maybeShowTour();
  maybeShowCoachmark();
  $("#f-refresh").onclick=function(){ S.seen={}; saveSeen(); draw(true); };
  $("#f-open").onclick=openFilters;
  $("#f-view").onclick=function(){ S.viewMode=S.viewMode==="list"?"deck":"list"; draw(false); $("#f-view").innerHTML=S.viewMode==="list"?"🃏 "+esc(t("deck_view")):"☰ "+esc(t("list_view")); };
  $("#c-skip").onclick=function(){ swipeTop("left"); };
  $("#c-help").onclick=function(){ var top=S.feed[0]; if(top) go("#/gift/"+encodeURIComponent(top.id)); };
  $("#c-reshuffle").onclick=function(){ S.feed.sort(function(){ return Math.random()-0.5; }); S.lastReshuffleAt=Date.now(); draw(false); };
  $("#c-undo").onclick=undoSwipe;
  document.addEventListener("keydown", swipeKeys);
  bindSearch();
  drawAskSwitcher();
  draw(true);

  function swipeKeys(e){
    if(location.hash.split("?")[0]!=="#/swipe") return;
    if(e.key==="ArrowLeft") swipeTop("left");
    if(e.key==="ArrowRight"){ var top=S.feed[0]; if(top) go("#/gift/"+encodeURIComponent(top.id)); }
  }
  function undoSwipe(){
    if(!S.lastSwiped) return;
    var b=S.lastSwiped; S.lastSwiped=null;
    delete S.seen[b.id]; saveSeen();
    S.feed.unshift(b);
    toast(t("undo_done"));
    draw(false);
  }
  function bindSearch(){
    var inp=$("#feed-search"), box=$("#feed-suggest");
    if(!inp) return;
    var timer=null;
    function showHelpers(){
      var helpers=$("#search-helpers"); if(!helpers) return;
      var recent=recentSearches();
      var popular=(S.facetCounts&&S.facetCounts.byCategory)? Object.keys(S.facetCounts.byCategory).sort(function(a,b){ return S.facetCounts.byCategory[b]-S.facetCounts.byCategory[a]; }).slice(0,5) : [];
      helpers.innerHTML=(recent.length?'<p class="small" style="margin:2px 0">'+esc(t("search_recent"))+': '+recent.map(function(r){ return '<button type="button" class="chip" data-recent="'+esc(r)+'">'+esc(r)+'</button>'; }).join(" ")+'</p>':"")
        +(popular.length?'<p class="small" style="margin:2px 0">'+esc(t("search_popular"))+': '+popular.map(function(r){ return '<button type="button" class="chip" data-recent="'+esc(r)+'">'+esc(r)+'</button>'; }).join(" ")+'</p>':"");
      $all("[data-recent]", helpers).forEach(function(b){ b.onclick=function(){ S.searchQ=b.getAttribute("data-recent"); inp.value=S.searchQ; applySearch(); }; });
    }
    function applySearch(){
      S.searchQ=inp.value.trim();
      if(S.searchQ) pushRecentSearch(S.searchQ);
      box.innerHTML="";
      S.seen={}; saveSeen();
      draw(true);
    }
    inp.addEventListener("keydown", function(e){ if(e.key==="Enter"){ e.preventDefault(); applySearch(); } });
    inp.addEventListener("input", function(){
      clearTimeout(timer);
      var q=inp.value.trim();
      if(q.length<2){ box.innerHTML=""; return; }
      timer=setTimeout(async function(){
        try{
          var d=await api("/feed/suggest?q="+encodeURIComponent(q));
          var list=pickList(d,["suggestions"]);
          if(!list.length){ box.innerHTML=""; return; }
          box.innerHTML='<div class="suggest-list">'+list.map(function(s){ return '<button type="button" data-sug="'+esc(s.text)+'">'+(s.kind==="category"?"📁 ":"🧾 ")+esc(s.text)+'</button>'; }).join("")+'</div>';
          $all("[data-sug]", box).forEach(function(b){ b.onclick=function(){ inp.value=b.getAttribute("data-sug"); applySearch(); }; });
        }catch(e){ box.innerHTML=""; }
      }, 250);
    });
    loadFacetCounts().then(function(){ showHelpers(); drawAskSwitcher(); });
    showHelpers();
  }
  function drawAskSwitcher(){
    var sw=$("#ask-switch"); if(!sw) return;
    var counts=S.facetCounts?S.facetCounts.byAskType:null;
    var types=[["",t("ask_type_all")],["bill",t("ask_type_bill")],["dream",t("ask_type_dream")],["business",t("ask_type_business")],["charity",t("ask_type_charity")]];
    sw.innerHTML=types.map(function(x){
      var c=counts&&x[0]?counts[x[0]]:null;
      return '<button type="button" data-v="'+x[0]+'" class="'+(S.filters.askType===x[0]?"on":"")+'">'+esc(x[1])+(c!=null?' <span class="cnt">('+c+')</span>':"")+'</button>';
    }).join("");
    $all("#ask-switch button").forEach(function(b){ b.onclick=function(){ S.filters.askType=b.getAttribute("data-v"); saveFilters(); S.seen={}; saveSeen(); drawAskSwitcher(); draw(true); }; });
  }
  function drawMeta(){
    var m=$("#feed-meta"); if(!m) return;
    var left=Math.max(0, S.feedTotal-Object.keys(S.seen).length);
    var viewed=Object.keys(S.seen).length;
    m.innerHTML='<span>📋 '+esc(t("asks_left",{n:left}))+'</span>'
      +'<span>'+esc(t("viewed_progress",{a:viewed,b:S.feedTotal}))+'</span>'
      +(streak>1?'<span>🔥 '+esc(t("streak_days",{n:streak}))+'</span>':"")
      +(S.feedUpdatedAt?'<span>'+esc(t("last_updated",{t:fmtClock(S.feedUpdatedAt)}))+'</span>':"")
      +(S.lastReshuffleAt?'<span>'+esc(t("reshuffled_at",{t:fmtClock(S.lastReshuffleAt)}))+'</span>':"");
    var fs=$("#filter-summary"); if(fs) fs.textContent=filterSummaryText();
  }
  function checkSavedNotices(){
    if(!S.saved.length) return;
    var funded=S.saved.filter(function(s){ return s.coveredMinor>=s.amountMinor&&s.amountMinor>0; });
    var expiring=S.saved.filter(function(s){ var d=daysLeftOf(s); return d!==null&&d<=3&&d>=0; });
    if(funded.length) toast(t("saved_funded_notice"));
    else if(expiring.length) toast(t("saved_expiring_notice",{n:Math.min.apply(null,expiring.map(function(s){ return daysLeftOf(s); }))}));
  }
  function maybeShowTour(){
    try{
      if(localStorage.getItem("sp_tour_seen")==="1") return;
      var steps=[
        {title:t("tour_title_1"), body:t("tour_body_1")},
        {title:t("tour_title_2"), body:t("tour_body_2")},
        {title:t("tour_title_3"), body:t("tour_body_3")}
      ];
      var idx=0;
      var ov=document.createElement("div");
      ov.className="tour-overlay";
      ov.innerHTML='<div class="card tour-card"><div class="step-dots">'+steps.map(function(_,i){ return '<i class="'+(i===0?"on":"")+'"></i>'; }).join("")+'</div><h2 id="tour-t"></h2><p id="tour-b"></p><button class="btn" id="tour-next"></button></div>';
      document.body.appendChild(ov);
      function show(){
        ov.querySelector("#tour-t").textContent=steps[idx].title;
        ov.querySelector("#tour-b").textContent=steps[idx].body;
        ov.querySelector("#tour-next").textContent=idx<2?t("tour_next"):t("tour_done");
        $all(".step-dots i", ov).forEach(function(d,i){ d.classList.toggle("on", i===idx); });
      }
      ov.querySelector("#tour-next").onclick=function(){
        if(idx<2){ idx++; show(); }
        else { try{ localStorage.setItem("sp_tour_seen","1"); }catch(e){} ov.remove(); }
      };
      show();
    }catch(e){}
  }
  function maybeShowCoachmark(){
    try{
      // Count a visit only if >60s since the last one — live-apply
      // re-renders the feed without it being a new visit.
      var last=Number(localStorage.getItem("sp_deck_visit_at")||0);
      if(Date.now()-last<60000) return;
      localStorage.setItem("sp_deck_visit_at", String(Date.now()));
      var n=Number(localStorage.getItem("sp_deck_visits")||0)+1;
      localStorage.setItem("sp_deck_visits", String(n));
      if(n>3) return;
      var c=document.createElement("div");
      c.className="coachmark";
      c.textContent=t("coachmark_swipe");
      document.body.appendChild(c);
      setTimeout(function(){ c.remove(); }, 4000);
    }catch(e){}
  }
  function drawExtra(){
    var ex=$("#feed-extra"); if(!ex) return;
    var counts=S.facetCounts;
    var cats=I.categories();
    var grid=counts? '<h2>'+esc(t("browse_categories"))+'</h2><div class="cat-grid">'+cats.map(function(c){
      var n=(counts.byCategory||{})[c]||0;
      return '<a class="card cat-tile" href="#/category/'+encodeURIComponent(c)+'"><span class="ic">'+categoryIcon(c)+'</span><span class="n">'+esc(c)+'</span><span class="c">'+esc(t("category_open_bills",{n:n}))+'</span></a>';
    }).join("")+'</div>' : "";
    var spot=function(type, title){
      var list=S.feed.filter(function(b){ return askTypeOf(b)===type; }).slice(0,6);
      if(!list.length) return "";
      return '<h2>'+esc(title)+'</h2><div class="spot-row">'+list.map(function(b){
        return '<a class="card spot-card" href="#/bill/'+encodeURIComponent(b.id)+'"><div class="t">'+esc(b.title||"")+'</div><p class="small">'+esc(money(b.amount_minor||b.amountMinor||0, b.currency))+' · '+esc(b.category||"")+'</p>'+progressHtml(b)+'</a>';
      }).join("")+'</div>';
    };
    ex.innerHTML=grid
      +spot("charity", t("charity_spotlight"))
      +spot("business", t("business_spotlight"))
      +'<p style="margin-top:10px"><a class="btn secondary" href="#/browse-types">🧾 '+esc(t("browse_by_type"))+'</a></p>';
  }
  async function draw(reset){
    var wrap=$("#deck-wrap"); if(!wrap) return;
    if(reset) wrap.innerHTML=skeleton(1);
    try{
      if(reset || S.feed.length===0) await loadFeed(reset);
      wrap=$("#deck-wrap"); if(!wrap) return; // navigated away mid-load
    }catch(e){ if(!document.getElementById("deck-wrap")) return; wrap.innerHTML=errBox(e.message); bindErrRetry(function(){ draw(true); }); var ctl=$("#swipe-controls"); if(ctl) ctl.hidden=true; return; }
    drawMeta();
    if(S.feed.length===0){
      $("#swipe-controls").hidden=true;
      var anyFilter = S.filters.categories.length||S.filters.band||S.filters.verifiedOnly||S.filters.idVerifiedOnly||S.filters.nameVerifiedOnly||S.filters.payDirectOnly||S.filters.charity||S.filters.askType||S.filters.billShown||S.filters.fundedOnly||S.filters.city||S.filters.near||S.filters.posted!=="any"||S.searchQ;
      var seenCount=Object.keys(S.seen).length;
      if(seenCount>0 && !anyFilter){
        // Deck finished (item 10) — every card swiped, no filters to blame.
        wrap.innerHTML=emptyState("🎉", t("deck_finished_title"), t("deck_finished_body"),
          '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap"><button class="btn small" id="e-again">'+esc(t("swipe_again"))+'</button><a class="btn secondary small" href="#/browse-types">'+esc(t("browse_all"))+'</a></div>');
        $("#e-again").onclick=function(){ S.seen={}; saveSeen(); draw(true); };
      } else if(S.searchQ){
        wrap.innerHTML=emptyState("🔍", t("search_no_results_title"), t("search_no_results_body"),
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center">'+I.categories().slice(0,6).map(function(c){ return '<button type="button" class="chip" data-catgo="'+esc(c)+'">'+categoryIcon(c)+' '+esc(c)+'</button>'; }).join("")+'</div><p style="margin-top:10px"><button class="btn secondary small" id="e-clearsearch">'+esc(t("clear_search"))+'</button></p>');
        $all("[data-catgo]", wrap).forEach(function(b){ b.onclick=function(){ S.searchQ=""; S.filters.categories=[b.getAttribute("data-catgo")]; saveFilters(); S.seen={}; saveSeen(); route(); }; });
        $("#e-clearsearch").onclick=function(){ S.searchQ=""; var inp=$("#feed-search"); if(inp) inp.value=""; S.seen={}; saveSeen(); draw(true); };
      } else if(S.filters.near){
        wrap.innerHTML=emptyState("📍", t("near_me_title"), t("near_me_empty"),
          '<button class="btn secondary small" id="e-clear">'+esc(t("clear_filters"))+'</button>');
        $("#e-clear").onclick=clearAllFilters;
      } else {
        wrap.innerHTML=emptyState("🧾", anyFilter?t("no_match_title"):t("no_bills_title"), anyFilter?t("no_match_body"):t("no_bills_body"),
          (anyFilter?'<button class="btn secondary small" id="e-clear">'+esc(t("clear_filters"))+'</button>':'<a class="btn small" href="#/post">'+esc(t("post_first_bill"))+'</a>'));
        var cb=$("#e-clear"); if(cb) cb.onclick=clearAllFilters;
      }
      drawExtra();
      return;
    }
    function clearAllFilters(){ S.filters=defaultFilters(); saveFilters(); S.searchQ=""; S.seen={}; saveSeen(); draw(true); }
    $("#swipe-controls").hidden=(S.viewMode==="list");
    if(S.viewMode==="list"){
      wrap.innerHTML='<div id="feed-list">'+S.feed.map(function(b){ return listRowHtml(b); }).join("")+'</div>'
        +(S.feedCursor?'<button class="btn secondary" id="feed-more" style="margin-top:10px">'+esc(t("more"))+'</button>':"")
        +(S.searchQ?'<p class="small" style="margin-top:8px">'+esc(t("search_results_count",{n:S.feedTotal}))+' · <button class="btn ghost small" id="list-clearsearch">'+esc(t("clear_search"))+'</button></p>':"");
      var fm=$("#feed-more"); if(fm) fm.onclick=function(){ loadFeed(false).then(function(){ draw(false); }).catch(function(){}); };
      var cs=$("#list-clearsearch"); if(cs) cs.onclick=function(){ S.searchQ=""; var inp=$("#feed-search"); if(inp) inp.value=""; S.seen={}; saveSeen(); draw(true); };
      drawExtra();
      return;
    }
    var today=new Date().toISOString().slice(0,10);
    var firstOfDayId=null;
    try{ firstOfDayId=JSON.parse(localStorage.getItem("sp_first_card")||"null"); }catch(e){}
    if(!firstOfDayId||firstOfDayId.day!==today){
      firstOfDayId={day:today, id:S.feed[0].id};
      try{ localStorage.setItem("sp_first_card", JSON.stringify(firstOfDayId)); }catch(e){}
    }
    wrap.innerHTML='<div class="deck" id="deck">'+S.feed.slice(0,3).map(function(b,i){ return swipeCardHtml(b,i,{firstOfDay: b.id===firstOfDayId.id}); }).join("")+'</div>'
      +(S.searchQ?'<p class="small" style="margin-top:8px">'+esc(t("search_results_count",{n:S.feedTotal}))+' · <button class="btn ghost small" id="deck-clearsearch">'+esc(t("clear_search"))+'</button></p>':"");
    var cs2=$("#deck-clearsearch"); if(cs2) cs2.onclick=function(){ S.searchQ=""; var inp=$("#feed-search"); if(inp) inp.value=""; S.seen={}; saveSeen(); draw(true); };
    bindDeck();
    drawExtra();
    if(S.feed.length<5 && S.feedCursor) loadFeed(false).then(function(){ if(location.hash==="#/swipe") draw(false); }).catch(function(){});
  }
  function bindDeck(){
    var card=$(".swipe-card[data-pos='0']"); if(!card) return;
    var startX=0, startY=0, dx=0, dragging=false, moved=false, longTimer=null, longFired=false;
    card.addEventListener("pointerdown", function(e){
      dragging=true; moved=false; longFired=false; startX=e.clientX; startY=e.clientY;
      card.classList.add("dragging"); card.setPointerCapture(e.pointerId);
      var id=card.getAttribute("data-id");
      longTimer=setTimeout(function(){
        if(dragging && !moved){
          longFired=true;
          var bill=S.feed.find(function(b){ return String(b.id)===String(id); });
          if(bill) openQuickActions(bill);
        }
      }, 600);
    });
    card.addEventListener("pointermove", function(e){
      if(!dragging) return;
      dx=e.clientX-startX; var dy=e.clientY-startY;
      if(Math.abs(dx)>6||Math.abs(dy)>6){ moved=true; clearTimeout(longTimer); }
      if(Math.abs(dy)>Math.abs(dx)*1.4 && Math.abs(dy)>30){ return; }
      card.style.transform="translateX("+dx+"px) rotate("+(dx/18)+"deg)";
      var l=card.querySelector(".overlay-tag.left"), r=card.querySelector(".overlay-tag.right");
      if(l) l.style.opacity=dx<-40?Math.min(1,(-dx-40)/60):0;
      if(r) r.style.opacity=dx>40?Math.min(1,(dx-40)/60):0;
    });
    function end(e){
      if(!dragging) return; dragging=false; clearTimeout(longTimer); card.classList.remove("dragging");
      if(longFired){ card.style.transform=""; dx=0; return; }
      if(dx>110){ swipeTop("right"); return; }
      if(dx<-110){ swipeTop("left"); return; }
      card.style.transform="";
      var l=card.querySelector(".overlay-tag.left"), r=card.querySelector(".overlay-tag.right");
      if(l) l.style.opacity=0; if(r) r.style.opacity=0;
      if(!moved){
        var act=e.target.closest("[data-act]");
        if(act){
          var id=card.getAttribute("data-id");
          var bill=S.feed.find(function(b){ return String(b.id)===String(id); });
          var a=act.getAttribute("data-act");
          if(a==="photo") go("#/photo/"+encodeURIComponent(id));
          if(a==="profile" && bill){ var u=(bill.user||bill.poster||{}).username||bill.username; if(u) go("#/profile/"+encodeURIComponent(u)); }
          if(a==="flip"){ e.preventDefault(); card.classList.toggle("flipped"); }
          if(a==="save" && bill){
            var nowSaved=toggleSaved(bill);
            act.innerHTML=(nowSaved?"🔖 "+esc(t("saved_bill")):"🔖 "+esc(t("save_bill")));
            act.setAttribute("aria-pressed", nowSaved?"true":"false");
            toast(nowSaved?t("saved_bill"):t("saved_unsaved"));
          }
          if(a==="report" && bill) openReportSheet("bill", bill.id);
        }
      }
      dx=0;
    }
    card.addEventListener("pointerup", end);
    card.addEventListener("pointercancel", end);
  }
  function openQuickActions(bill){
    openSheet('<h2>'+esc(t("quick_actions"))+'</h2><p><strong>'+esc(bill.title||"")+'</strong></p>'
      +'<div style="display:grid;gap:8px;margin-top:10px">'
      +'<button class="btn secondary" id="qa-save">🔖 '+(isSaved(bill.id)?esc(t("unsave_bill")):esc(t("save_bill")))+'</button>'
      +'<button class="btn secondary" id="qa-share">🔗 '+esc(t("share"))+'</button>'
      +'<button class="btn secondary" id="qa-photo">🖼️ '+esc(t("bill_photo_heading"))+'</button>'
      +'<button class="btn secondary" id="qa-report">🚩 '+esc(t("report"))+'</button>'
      +'<a class="btn" href="#/bill/'+encodeURIComponent(bill.id)+'">'+esc(t("view_bill"))+'</a></div>');
    $("#qa-save").onclick=function(){ toggleSaved(bill); closeSheets(); draw(false); };
    $("#qa-share").onclick=function(){ copyText(location.origin+location.pathname+"#/bill/"+bill.id, t("copied_link")); closeSheets(); };
    $("#qa-photo").onclick=function(){ closeSheets(); go("#/photo/"+encodeURIComponent(bill.id)); };
    $("#qa-report").onclick=function(){ closeSheets(); openReportSheet("bill", bill.id); };
  }
  function swipeTop(dir){
    var now=Date.now();
    if(now-S.lastSwipeAt<300) return; // 300ms double-swipe guard (item 11)
    S.lastSwipeAt=now;
    var top=S.feed[0]; if(!top) return;
    try{ if(navigator.vibrate) navigator.vibrate(10); }catch(e){}
    var card=$(".swipe-card[data-pos='0']"); if(card) card.classList.add("snap");
    S.lastSwiped=top;
    S.seen[top.id]=Date.now(); saveSeen();
    S.feed.shift();
    if(dir==="right"){ go("#/gift/"+encodeURIComponent(top.id)); return; }
    draw(false);
  }
}
function openFilters(){
  var f=S.filters;
  var cats=I.categories();
  var counts=S.facetCounts||{};
  var byCat=counts.byCategory||{}, byBand=counts.byBand||{}, byType=counts.byAskType||{};
  function cnt(n){ return n!=null?' <span class="cnt">('+n+')</span>':""; }
  openSheet('<h2>'+esc(t("filters"))+'</h2><p class="small">'+esc(t("per_page_note"))+'</p>'
    +'<label>'+esc(t("filter_country"))+'</label><div class="seg" id="fl-country"><button type="button" data-v="own" class="'+(f.country==="own"?"on":"")+'">'+esc(t("near_me"))+'</button><button type="button" data-v="NP" class="'+(f.country==="NP"?"on":"")+'">🇳🇵 '+esc(t("nepal"))+'</button><button type="button" data-v="IN" class="'+(f.country==="IN"?"on":"")+'">🇮🇳 '+esc(t("india"))+'</button><button type="button" data-v="all" class="'+(f.country==="all"?"on":"")+'">'+esc(t("all_countries"))+'</button></div>'
    +'<label id="lbl-flcats">'+esc(t("categories"))+'</label><div id="fl-cats" role="group" aria-labelledby="lbl-flcats" style="display:flex;flex-wrap:wrap;gap:6px">'+cats.map(function(c){ return '<button type="button" class="chip'+(f.categories.indexOf(c)>=0?" on":"")+'" data-cat="'+esc(c)+'" aria-pressed="'+(f.categories.indexOf(c)>=0?"true":"false")+'">'+categoryIcon(c)+' '+esc(c)+cnt(byCat[c])+'</button>'; }).join("")+'</div>'
    +'<label>'+esc(t("amount_band"))+'</label><div class="seg" id="fl-band" style="flex-wrap:wrap"><button type="button" data-v="" class="'+(!f.band?"on":"")+'">'+esc(t("all"))+'</button><button type="button" data-v="small" class="'+(f.band==="small"?"on":"")+'">'+esc(t("band_small"))+cnt(byBand.small)+'</button><button type="button" data-v="medium" class="'+(f.band==="medium"?"on":"")+'">'+esc(t("band_medium"))+cnt(byBand.medium)+'</button><button type="button" data-v="large" class="'+(f.band==="large"?"on":"")+'">'+esc(t("band_large"))+cnt(byBand.large)+'</button><button type="button" data-v="huge" class="'+(f.band==="huge"?"on":"")+'">'+esc(t("band_huge"))+cnt(byBand.huge)+'</button><button type="button" data-v="humongous" class="'+(f.band==="humongous"?"on":"")+'">'+esc(t("band_humongous"))+cnt(byBand.humongous)+'</button></div>'
    +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px"><div><label for="fl-amin">'+esc(t("amount_min_label"))+'</label><input id="fl-amin" type="number" min="0" step="1" value="'+esc(f.amountMin||"")+'" placeholder="0"></div><div><label for="fl-amax">'+esc(t("amount_max_label"))+'</label><input id="fl-amax" type="number" min="0" step="1" value="'+esc(f.amountMax||"")+'" placeholder="—"></div></div>'
    +'<label>'+esc(t("ask_type_all"))+'</label><div class="seg" id="fl-type" style="flex-wrap:wrap"><button type="button" data-v="" class="'+(!f.askType?"on":"")+'">'+esc(t("all"))+'</button><button type="button" data-v="bill" class="'+(f.askType==="bill"?"on":"")+'">🧾 '+esc(t("ask_type_bill"))+cnt(byType.bill)+'</button><button type="button" data-v="dream" class="'+(f.askType==="dream"?"on":"")+'">✨ '+esc(t("ask_type_dream"))+cnt(byType.dream)+'</button><button type="button" data-v="business" class="'+(f.askType==="business"?"on":"")+'">🏪 '+esc(t("ask_type_business"))+cnt(byType.business)+'</button><button type="button" data-v="charity" class="'+(f.askType==="charity"?"on":"")+'">🎗️ '+esc(t("ask_type_charity"))+cnt(byType.charity)+'</button></div>'
    +'<label>'+esc(t("verified_only"))+'</label><div style="display:flex;flex-wrap:wrap;gap:6px" id="fl-verchips">'
    +'<button type="button" class="chip'+(f.verifiedOnly?" on":"")+'" data-k="verifiedOnly">✓ '+esc(t("verified_only"))+cnt(counts.verified)+'</button>'
    +'<button type="button" class="chip'+(f.idVerifiedOnly?" on":"")+'" data-k="idVerifiedOnly">🪪 '+esc(t("id_verified_chip"))+cnt(counts.idVerified)+'</button>'
    +'<button type="button" class="chip'+(f.nameVerifiedOnly?" on":"")+'" data-k="nameVerifiedOnly">✓ '+esc(t("name_verified_chip"))+cnt(counts.nameVerified)+'</button>'
    +'<button type="button" class="chip'+(f.billShown?" on":"")+'" data-k="billShown">📄 '+esc(t("bill_shown"))+cnt(counts.billShown)+'</button>'
    +'<button type="button" class="chip'+(f.fundedOnly?" on":"")+'" data-k="fundedOnly">✅ '+esc(t("fully_funded_only"))+cnt(counts.fullyFunded)+'</button></div>'
    +'<label class="check-row"><input type="checkbox" id="fl-verified-first" '+(f.verifiedFirst?"checked":"")+'> '+esc(t("verified_first"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="fl-paydirect" '+(f.payDirectOnly?"checked":"")+'> '+esc(t("pay_direct_only"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="fl-charity" '+(f.charity?"checked":"")+'> '+esc(t("charity_only"))+'</label>'
    +'<label>'+esc(t("posted"))+'</label><div class="seg" id="fl-posted"><button type="button" data-v="any" class="'+(f.posted==="any"?"on":"")+'">'+esc(t("any_time"))+'</button><button type="button" data-v="today" class="'+(f.posted==="today"?"on":"")+'">'+esc(t("today"))+'</button><button type="button" data-v="week" class="'+(f.posted==="week"?"on":"")+'">'+esc(t("this_week"))+'</button><button type="button" data-v="month" class="'+(f.posted==="month"?"on":"")+'">'+esc(t("this_month"))+'</button></div>'
    +'<label for="fl-city">'+esc(t("near_me"))+'</label><div style="position:relative"><input id="fl-city" value="'+esc(f.city||"")+'" placeholder="'+esc(t("city_ph"))+'" autocomplete="off"><div id="fl-city-sug"></div></div>'
    +'<label for="fl-near">'+esc(t("near_me_radius",{n:f.radiusKm||50}))+'</label><div style="position:relative"><input id="fl-near" value="'+esc(f.near||"")+'" placeholder="'+esc(t("city_picker_ph"))+'" autocomplete="off"><div id="fl-near-sug"></div></div>'
    +'<label for="fl-radius">'+esc(t("near_me_radius",{n:f.radiusKm||50}))+'</label><input id="fl-radius" type="range" min="10" max="500" step="10" value="'+(f.radiusKm||50)+'"><p class="small" id="fl-radius-val"></p>'
    +(S.user&&S.user.city?'<p style="margin:6px 0"><button type="button" class="btn secondary small" id="fl-samecity">📍 '+esc(t("same_city_chip"))+' ('+esc(S.user.city)+')</button></p>':"")
    +'<label>'+esc(t("sort"))+'</label><div class="seg" id="fl-sort" style="flex-wrap:wrap"><button type="button" data-v="recommended" class="'+(f.sort==="recommended"?"on":"")+'">'+esc(t("sort_recommended"))+'</button><button type="button" data-v="newest" class="'+(f.sort==="newest"?"on":"")+'">'+esc(t("sort_newest"))+'</button><button type="button" data-v="almost_funded" class="'+(f.sort==="almost_funded"?"on":"")+'">'+esc(t("sort_almost"))+'</button><button type="button" data-v="most_supported" class="'+(f.sort==="most_supported"?"on":"")+'">'+esc(t("sort_supported"))+'</button><button type="button" data-v="fewest_supported" class="'+(f.sort==="fewest_supported"?"on":"")+'">'+esc(t("sort_fewest"))+'</button><button type="button" data-v="largest" class="'+(f.sort==="largest"?"on":"")+'">'+esc(t("sort_largest"))+'</button><button type="button" data-v="smallest" class="'+(f.sort==="smallest"?"on":"")+'">'+esc(t("sort_smallest"))+'</button><button type="button" data-v="needs_most" class="'+(f.sort==="needs_most"?"on":"")+'">'+esc(t("sort_needs_most"))+'</button></div>'
    +'<div class="btn-row"><button class="btn secondary" id="fl-clear">'+esc(t("clear_filters"))+'</button><button class="btn" id="fl-apply">'+esc(t("apply_filters"))+'</button></div>');
  function seg(id, fn){ $all("#"+id+" button").forEach(function(b){ b.onclick=function(){ $all("#"+id+" button").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on"); fn(b.getAttribute("data-v")); applyLive(); }; }); }
  var nf=JSON.parse(JSON.stringify(f));
  function applyLive(){
    // Live-apply (item 39): every change re-renders the feed behind the
    // sheet. renderSwipe (not route) so the sheet stays open.
    S.filters=JSON.parse(JSON.stringify(nf));
    saveFilters(); S.seen={}; saveSeen();
    if(location.hash.split("?")[0]==="#/swipe") renderSwipe();
  }
  function citySuggest(inputId, sugId, onPick){
    var inp=$("#"+inputId), box=$("#"+sugId);
    inp.addEventListener("input", function(){
      var q=inp.value.trim().toLowerCase();
      if(q.length<2){ box.innerHTML=""; return; }
      var matches=citiesList().filter(function(c){ return c[0].toLowerCase().indexOf(q)>=0; }).slice(0,6);
      if(!matches.length){ box.innerHTML=""; return; }
      box.innerHTML='<div class="suggest-list">'+matches.map(function(c){ return '<button type="button" data-city="'+esc(c[0])+'">'+flag(c[1])+' '+esc(c[0])+'</button>'; }).join("")+'</div>';
      $all("[data-city]", box).forEach(function(b){ b.onclick=function(){ inp.value=b.getAttribute("data-city"); box.innerHTML=""; onPick(inp.value); }; });
    });
  }
  seg("fl-country", function(v){ nf.country=v; });
  seg("fl-band", function(v){ nf.band=v; });
  seg("fl-type", function(v){ nf.askType=v; });
  seg("fl-posted", function(v){ nf.posted=v; });
  seg("fl-sort", function(v){ nf.sort=v; });
  $all("#fl-cats .chip").forEach(function(b){ b.onclick=function(){ var c=b.getAttribute("data-cat"); var i=nf.categories.indexOf(c); if(i>=0) nf.categories.splice(i,1); else nf.categories.push(c); b.classList.toggle("on"); b.setAttribute("aria-pressed", b.classList.contains("on")?"true":"false"); applyLive(); }; });
  $all("#fl-verchips .chip").forEach(function(b){ b.onclick=function(){ var k=b.getAttribute("data-k"); nf[k]=!nf[k]; b.classList.toggle("on", nf[k]); applyLive(); }; });
  $("#fl-verified-first").addEventListener("change", function(){ nf.verifiedFirst=$("#fl-verified-first").checked; applyLive(); });
  $("#fl-paydirect").addEventListener("change", function(){ nf.payDirectOnly=$("#fl-paydirect").checked; applyLive(); });
  $("#fl-charity").addEventListener("change", function(){ nf.charity=$("#fl-charity").checked; applyLive(); });
  $("#fl-amin").addEventListener("change", function(){ nf.amountMin=$("#fl-amin").value.trim(); applyLive(); });
  $("#fl-amax").addEventListener("change", function(){ nf.amountMax=$("#fl-amax").value.trim(); applyLive(); });
  citySuggest("fl-city", "fl-city-sug", function(v){ nf.city=v; applyLive(); });
  citySuggest("fl-near", "fl-near-sug", function(v){ nf.near=v; applyLive(); });
  $("#fl-city").addEventListener("change", function(){ nf.city=$("#fl-city").value.trim(); applyLive(); });
  $("#fl-near").addEventListener("change", function(){ nf.near=$("#fl-near").value.trim(); applyLive(); });
  var radius=$("#fl-radius");
  function radiusLabel(){ $("#fl-radius-val").textContent=t("near_me_radius",{n:radius.value}); }
  radiusLabel();
  radius.addEventListener("input", radiusLabel);
  radius.addEventListener("change", function(){ nf.radiusKm=Number(radius.value); applyLive(); });
  var sc=$("#fl-samecity");
  if(sc) sc.onclick=function(){ nf.near=S.user.city; $("#fl-near").value=S.user.city; applyLive(); };
  $("#fl-clear").onclick=function(){ S.filters=defaultFilters(); saveFilters(); S.seen={}; saveSeen(); closeSheets(); route(); };
  $("#fl-apply").onclick=function(){
    nf.city=$("#fl-city").value.trim(); nf.near=$("#fl-near").value.trim();
    nf.amountMin=$("#fl-amin").value.trim(); nf.amountMax=$("#fl-amax").value.trim();
    nf.radiusKm=Number($("#fl-radius").value)||50;
    S.filters=nf; saveFilters(); S.seen={}; saveSeen(); closeSheets(); route();
  };
}

/* ---------- bill detail / photo ---------- */
async function fetchBill(id){
  var d=await api("/bills/"+encodeURIComponent(id));
  return d.bill||d;
}
function renderBill(id){
  var tok=view(skeleton(2));
  fetchBill(id).then(function(bill){
    if(tok!==NAV) return;
    var cur=bill.currency||curOf(bill.country);
    var user=bill.user||bill.poster||{};
    var name=bill.anonymous? t("anonymous") : (user.display_name||user.displayName||bill.display_name||bill.displayName||(bill.user||{}).display_name||bill.username||"");
    var uname=user.username||bill.username||"";
    var photo=bill.photo_url||bill.photoUrl||bill.public_photo_url||"";
    var supporters=pickList(bill,["supporters"]);
    var isOwner=S.user && (String(bill.user_id)===String(S.user.id) || String(bill.userId)===String(S.user.id));
    view('<a href="#/swipe" class="small">← '+esc(t("back"))+'</a>'
      +'<div class="card" style="margin-top:8px">'
      +(photo?'<a href="#/photo/'+encodeURIComponent(bill.id)+'"><img class="bill-photo" src="'+esc(photo)+'" alt="'+esc(t("bill_photo_alt"))+'"></a>':"")
      +'<h1>'+esc(bill.title||"")+'</h1>'
      +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">'+badgesHtml(bill)+askTypeBadge(bill)+'<span class="chip">'+categoryIcon(bill.category)+' '+esc(bill.category||"")+'</span>'+statusChip(bill.status)+((bill.expiresAt||bill.expires_at)?'<span class="chip">⏳ '+esc(expiryLabel(bill))+'</span>':"")+'</div>'
      +'<p><span class="money" style="font-size:24px;font-weight:800">'+esc(money(bill.amount_minor||bill.amountMinor||0,cur))+'</span></p>'
      + progressHtml(bill)
      +'<div class="kv"><span>'+esc(t("biller"))+'</span><b>'+esc(bill.company||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("due_date"))+'</span><b>'+esc((bill.dueDate||bill.due_date)?fmtDate(bill.dueDate||bill.due_date):"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("city"))+'</span><b>'+flag(bill.country)+' '+esc(bill.city||"")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("request_id"))+'</span><b>'+esc(bill.request_code||bill.requestCode||bill.id||"")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("views"))+'</span><b>'+esc(bill.views||0)+'</b></div>'
      +'<div class="kv"><span>'+esc(t("payout_hint"))+'</span><b>'+esc(bill.payout_hint||bill.payoutHint||bill.payout_method||"—")+'</b></div>'
      +'<h2>'+esc(t("story"))+'</h2><p>'+esc(bill.story||"")+'</p>'
      +(bill.details?'<h2>'+esc(t("details"))+'</h2><p>'+esc(bill.details)+'</p>':"")
      +((bill.forWhom||bill.for_whom)&&bill.forWhom!=="myself"?'<p class="small">'+esc(t("for_whom_label"))+' '+esc(bill.forWhom==="family"?t("for_family"):t("for_other"))+(bill.relationship?' ('+esc(bill.relationship)+')':"")+'</p>':"")
      +(bill.charityName?'<p><strong>'+esc(t("charity_name_label"))+'</strong><br>'+esc(bill.charityName)+'</p>':"")
      +(bill.businessName?'<p><strong>'+esc(t("business_name_label"))+'</strong><br>'+esc(bill.businessName)+(bill.businessDesc?'<br>'+esc(bill.businessDesc):"")+'</p>':"")
      +(bill.dreamDesc?'<p><strong>'+esc(t("dream_desc_label"))+'</strong><br>'+esc(bill.dreamDesc)+'</p>':"")
      +(bill.notPaidConsequence?'<p><strong>'+esc(t("not_paid_label"))+'</strong><br>'+esc(bill.notPaidConsequence)+'</p>':"")
      +(bill.triedToPay?'<p><strong>'+esc(t("tried_pay_label"))+'</strong><br>'+esc(bill.triedToPay)+'</p>':"")
      +(bill.moneyMeans?'<p><strong>'+esc(t("money_means_label"))+'</strong><br>'+esc(bill.moneyMeans)+'</p>':"")
      +'<div class="row-card card" id="poster-row" tabindex="0" role="button" aria-label="'+esc(name)+'" style="margin-top:12px"><div class="avatar">'+(user.photo_url||user.photoUrl?'<img src="'+esc(user.photo_url||user.photoUrl)+'" alt="">':esc(initials(name)))+'</div><div class="grow"><div class="t">'+esc(name)+'</div><div class="s">@'+esc(uname)+' · '+esc(t("member_since"))+' '+esc((user.memberSince||user.created_at)?fmtDate(user.memberSince||user.created_at):"")+'</div></div><span>›</span></div>'
      +'<div class="btn-row"><a class="btn" href="#/gift/'+encodeURIComponent(bill.id)+'">💙 '+esc(t("help_this_bill"))+'</a></div>'
      +((bill.pay_direct||bill.payDirect)?'<div class="btn-row"><button class="btn secondary" id="pay-direct-btn">'+esc(t("pay_direct"))+'</button></div>':"")
      +'<div class="btn-row"><button class="btn secondary small" id="share-btn">🔗 '+esc(t("share"))+'</button><button class="btn secondary small" id="save-btn">🔖 '+(isSaved(bill.id)?esc(t("saved_bill")):esc(t("save_bill")))+'</button><button class="btn secondary small" id="basket-btn">🧺 '+esc(t("add_basket"))+'</button><button class="btn secondary small" id="report-btn">🚩 '+esc(t("report"))+'</button></div>'
      +(isOwner?'<div class="btn-row"><a class="btn secondary small" href="#/mybills">'+esc(t("my_bills"))+'</a></div>':"")
      +'</div>'
      +'<div class="card" style="margin-top:12px"><h2>'+esc(t("supporters_title"))+' ('+supporters.length+')</h2>'
      +(supporters.length? supporters.map(function(s){ return '<div class="kv"><span>'+esc(s.anonymous?t("anonymous"):(s.display_name||s.displayName||s.username||t("anonymous")))+'</span><b>'+esc(money(s.amount_minor||s.amountMinor||0,cur))+'</b></div>'; }).join("") : '<p>'+esc(t("no_supporters"))+'</p>')
      +'</div>'
      +'<div class="card" style="margin-top:12px"><h2>'+esc(t("how_helping"))+'</h2><p>'+esc(t("how_helping_body"))+'</p>'+neverHoldsHtml()+'</div>');
    $("#poster-row").onclick=function(){ if(uname) go("#/profile/"+encodeURIComponent(uname)); };
    $("#poster-row").addEventListener("keydown", function(e){ if((e.key==="Enter"||e.key===" ")&&uname){ e.preventDefault(); go("#/profile/"+encodeURIComponent(uname)); } });
    $("#share-btn").onclick=function(){ copyText(location.origin+location.pathname+"#/bill/"+bill.id, t("copied_link")); };
    $("#save-btn").onclick=function(){ var s=toggleSaved(bill); $("#save-btn").innerHTML="🔖 "+esc(s?t("saved_bill"):t("save_bill")); toast(s?t("saved_bill"):t("saved_unsaved")); };
    $("#basket-btn").onclick=function(){
      if(S.basket.indexOf(bill.id)<0){ S.basket.push(bill.id); saveBasket(); toast(t("add_to_basket_done")); } else toast(t("basket"));
    };
    $("#report-btn").onclick=function(){ openReportSheet("bill", bill.id); };
    var pd=$("#pay-direct-btn"); if(pd) pd.onclick=function(){ openPayDirect(bill); };
  }).catch(function(e){
    if(tok!==NAV) return;
    view(emptyState("🧾", t("bill_not_found"), e.message||"", '<a class="btn small" href="#/swipe">'+esc(t("go_swipe"))+'</a>', "h1"));
  });
}
function openPayDirect(bill){
  openSheet('<h2>'+esc(t("direct_pay_title"))+'</h2>'+demoHtml()
    +'<p>'+esc(t("direct_pay_note"))+'</p>'
    +'<div class="kv"><span>'+esc(t("biller"))+'</span><b>'+esc(bill.biller_name||bill.billerName||bill.company||"")+'</b></div>'
    +'<div class="kv"><span>'+esc(t("amount"))+'</span><b>'+esc(money(bill.amount_minor||bill.amountMinor||0, bill.currency))+'</b></div>'
    +'<div class="kv"><span>'+esc(t("due_date"))+'</span><b>'+esc((bill.dueDate||bill.due_date)?fmtDate(bill.dueDate||bill.due_date):"—")+'</b></div>'
    +((bill.billerDestination||bill.biller_destination)?'<div class="kv"><span>'+esc(t("biller_destination"))+'</span><b>'+esc(bill.billerDestination||bill.biller_destination)+'</b></div>':"")
    +'<p>'+esc(t("pay_biller_steps"))+'</p>'
    +'<a class="btn" href="#/gift/'+encodeURIComponent(bill.id)+'?direct=1">'+esc(t("continue_btn"))+'</a>');
}
function openReportSheet(targetType, targetId){
  if(!needUser()) return;
  var reasons=[
    ["fraud", t("reason_fraud")], ["impersonation", t("reason_impersonation")],
    ["mismatch", t("reason_mismatch")], ["deception", t("reason_deception")],
    ["name_mismatch", t("reason_name_mismatch")], ["personal", t("reason_personal")],
    ["offensive", t("reason_offensive")], ["under18", t("reason_under18")], ["other", t("report_other")]
  ];
  openSheet('<h2>'+esc(t("report"))+'</h2><p class="small">'+esc(t("your_reports"))+'</p>'
    +'<label>'+esc(t("report_reason"))+'</label><div id="rep-reasons" style="display:grid;gap:6px">'+reasons.map(function(r){ return '<button type="button" class="btn secondary small" style="text-align:left" data-r="'+r[0]+'">'+esc(r[1])+'</button>'; }).join("")+'</div>'
    +'<label for="rep-note">'+esc(t("report_note"))+'</label><textarea id="rep-note" maxlength="600"></textarea>'
    +'<div class="btn-row"><button class="btn secondary" id="rep-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="rep-send" disabled>'+esc(t("send_report"))+'</button></div>');
  var chosen=null;
  $all("#rep-reasons button").forEach(function(b){ b.onclick=function(){ chosen=b.getAttribute("data-r"); $all("#rep-reasons button").forEach(function(x){ x.style.borderColor=""; }); b.style.borderColor="var(--accent)"; $("#rep-send").disabled=false; }; });
  $("#rep-cancel").onclick=closeSheets;
  $("#rep-send").onclick=async function(){
    var btn=$("#rep-send"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var res=await api("/reports", {method:"POST", body:{targetType:targetType, targetId:targetId, reason:chosen, note:$("#rep-note").value.trim()}});
      closeSheets();
      toast(res&&res.paused? t("report_paused") : t("report_sent"));
      if(res&&res.paused) route();
    }catch(e){ btn.disabled=false; btn.textContent=t("send_report"); toast(e.message||t("err_generic"), true); }
  };
}
function renderPhoto(billId){
  var tok=view('<a href="#/bill/'+encodeURIComponent(billId)+'" class="small">← '+esc(t("back"))+'</a><h1>'+esc(t("bill_photo_heading"))+'</h1><div id="photo-wrap" style="margin-top:10px">'+skeleton(1)+'</div>');
  fetchBill(billId).then(function(bill){
    if(tok!==NAV) return;
    var photos=[];
    if(Array.isArray(bill.photos)&&bill.photos.length) photos=bill.photos.slice();
    else if(bill.photo_url||bill.photoUrl) photos=[bill.photo_url||bill.photoUrl];
    var sup=bill.support_photo_url||bill.supportPhotoUrl||"";
    if(sup) photos.push(sup);
    var wrap=$("#photo-wrap"); if(!wrap) return;
    if(!photos.length){
      wrap.innerHTML=emptyState("🖼️", t("no_photo"), "", "");
      return;
    }
    var idx=0, scale=1, tx=0, ty=0;
    var cap=t("photo_caption",{type:bill.category||"", amount:money(bill.amount_minor||bill.amountMinor||0, bill.currency)});
    wrap.innerHTML='<div class="pv-stage" id="pv-stage"><img id="pv-img" src="'+esc(photos[0])+'" alt="'+esc(t("bill_photo_alt"))+'">'
      +(photos.length>1?'<button class="pv-nav pv-prev" id="pv-prev" aria-label="'+esc(t("back"))+'">‹</button><button class="pv-nav pv-next" id="pv-next" aria-label="'+esc(t("next"))+'">›</button>':"")
      +'</div><p class="small" style="text-align:center;margin:8px 0 2px">'+esc(cap)+'</p>'
      +'<p class="small muted" style="text-align:center">'+esc(t("photo_zoom_hint"))+'</p>'
      +'<p class="small" style="text-align:center" id="pv-count">'+esc(t("photo_of",{a:1,b:photos.length}))+'</p>'
      +'<div class="btn-row"><a class="btn" href="#/gift/'+encodeURIComponent(bill.id)+'">💙 '+esc(t("help_this_bill"))+'</a><button class="btn secondary" id="ph-share">🔗 '+esc(t("share"))+'</button></div>';
    var img=$("#pv-img"), stage=$("#pv-stage");
    function applyTransform(){ img.style.transform="translate("+tx+"px,"+ty+"px) scale("+scale+")"; }
    function show(i){
      idx=(i+photos.length)%photos.length;
      scale=1; tx=0; ty=0;
      img.src=photos[idx];
      applyTransform();
      var c=$("#pv-count"); if(c) c.textContent=t("photo_of",{a:idx+1,b:photos.length});
    }
    var pv=$("#pv-prev"); if(pv) pv.onclick=function(){ show(idx-1); };
    var nx=$("#pv-next"); if(nx) nx.onclick=function(){ show(idx+1); };
    // Pinch-to-zoom + drag pan + horizontal swipe between photos.
    var pointers=new Map(), startDist=0, startScale=1, startX=0, lastX=0, lastY=0, panning=false;
    stage.addEventListener("pointerdown", function(e){
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if(pointers.size===2){
        var pts=Array.from(pointers.values());
        startDist=Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
        startScale=scale;
      } else { startX=e.clientX; lastX=e.clientX; lastY=e.clientY; panning=true; }
    });
    stage.addEventListener("pointermove", function(e){
      if(!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
      if(pointers.size===2){
        var pts=Array.from(pointers.values());
        var d=Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
        if(startDist>0) scale=Math.min(4, Math.max(1, startScale*d/startDist));
        applyTransform();
      } else if(panning){
        var dx=e.clientX-lastX, dy=e.clientY-lastY;
        lastX=e.clientX; lastY=e.clientY;
        if(scale>1){ tx+=dx; ty+=dy; applyTransform(); }
      }
    });
    function pvEnd(e){
      var wasSwipe=panning&&scale===1&&Math.abs(e.clientX-startX)>60;
      pointers.delete(e.pointerId);
      if(pointers.size===0) panning=false;
      if(wasSwipe) show(e.clientX>startX?idx-1:idx+1);
    }
    stage.addEventListener("pointerup", pvEnd);
    stage.addEventListener("pointercancel", function(e){ pointers.delete(e.pointerId); panning=false; });
    img.addEventListener("dblclick", function(){ scale=scale>1?1:2; tx=0; ty=0; applyTransform(); });
    var s=$("#ph-share"); if(s) s.onclick=function(){ copyText(location.origin+location.pathname+"#/bill/"+bill.id, t("copied_link")); };
  }).catch(function(e){ if(tok!==NAV) return; var wrap=$("#photo-wrap"); if(!wrap) return; wrap.innerHTML=emptyState("🧾", t("bill_not_found"), e.message||""); });
}

/* ---------- saved bills / categories / browse by type ---------- */
function renderSaved(){
  view('<h1>'+esc(t("saved_title"))+'</h1>'
    +'<label for="sv-sort">'+esc(t("saved_sort_label"))+'</label><div class="seg" id="sv-sort"><button type="button" data-v="date" class="on">'+esc(t("saved_sort_date"))+'</button><button type="button" data-v="amount">'+esc(t("saved_sort_amount"))+'</button><button type="button" data-v="progress">'+esc(t("saved_sort_progress"))+'</button></div>'
    +'<div id="sv-undo"></div><div id="sv-body" style="margin-top:10px">'+skeleton(2)+'</div>');
  var sortMode="date";
  $all("#sv-sort button").forEach(function(b){ b.onclick=function(){ sortMode=b.getAttribute("data-v"); $all("#sv-sort button").forEach(function(x){ x.classList.toggle("on", x===b); }); load(); }; });
  load();
  async function load(){
    var body=$("#sv-body"); if(!body) return;
    if(!S.saved.length){
      body.innerHTML=emptyState("🔖", t("saved_empty_title"), t("saved_empty_body"), '<a class="btn small" href="#/swipe">'+esc(t("go_swipe"))+'</a>');
      return;
    }
    // Refresh funding status live; fall back to the stored snapshot when a
    // bill is gone (expired/removed) — the snapshot still tells its story.
    var items=await Promise.all(S.saved.map(async function(s){
      try{
        var d=await api("/bills/"+encodeURIComponent(s.id));
        var b=d.bill||d;
        return {id:s.id, savedAt:s.savedAt, title:b.title||s.title, amountMinor:b.amountMinor||s.amountMinor, coveredMinor:b.coveredMinor||0, currency:b.currency||s.currency, category:b.category||s.category, expiresAt:b.expiresAt||s.expiresAt, status:b.status||"approved", gone:false};
      }catch(e){ return Object.assign({}, s, {gone:true}); }
    }));
    if(sortMode==="amount") items.sort(function(a,b){ return b.amountMinor-a.amountMinor; });
    else if(sortMode==="progress") items.sort(function(a,b){ var pa=a.amountMinor?(a.coveredMinor/a.amountMinor):0, pb=b.amountMinor?(b.coveredMinor/b.amountMinor):0; return pb-pa; });
    else items.sort(function(a,b){ return b.savedAt-a.savedAt; });
    body.innerHTML=items.map(function(s){
      return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(s.title||"")+'</strong>'+statusChip(s.gone?"removed":s.status)+'</div>'
        +'<p class="small">'+esc(s.category||"")+' · '+esc(money(s.amountMinor||0, s.currency))+(s.expiresAt?' · '+esc(expiryLabel(s)):"")+'</p>'
        + progressHtml({amount_minor:s.amountMinor, covered_minor:s.coveredMinor, currency:s.currency})
        +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
        +(s.gone?"":'<a class="btn secondary small" href="#/bill/'+encodeURIComponent(s.id)+'">'+esc(t("view_bill"))+'</a>')
        +'<button class="btn secondary small" data-sv-share="'+esc(s.id)+'">🔗 '+esc(t("share"))+'</button>'
        +'<button class="btn secondary small" data-sv-unsave="'+esc(s.id)+'">'+esc(t("unsave_bill"))+'</button></div></div>';
    }).join("");
    $all("[data-sv-share]", body).forEach(function(b){ b.onclick=function(){ copyText(location.origin+location.pathname+"#/bill/"+b.getAttribute("data-sv-share"), t("copied_link")); }; });
    $all("[data-sv-unsave]", body).forEach(function(b){ b.onclick=function(){
      var id=b.getAttribute("data-sv-unsave");
      var i=S.saved.findIndex(function(x){ return String(x.id)===String(id); });
      if(i<0) return;
      var removed=S.saved.splice(i,1)[0];
      saveSaved();
      var undo=$("#sv-undo");
      undo.innerHTML='<div class="notice info" style="margin-top:10px">'+esc(t("saved_unsaved"))+' <button class="btn small" id="sv-undo-btn" style="margin-left:8px">'+esc(t("undo_swipe"))+'</button></div>';
      $("#sv-undo-btn").onclick=function(){ S.saved.unshift(removed); saveSaved(); undo.innerHTML=""; load(); };
      setTimeout(function(){ if(undo) undo.innerHTML=""; }, 8000);
      load();
    }; });
  }
}
function renderCategory(catName){
  var cat=decodeURIComponent(catName||"");
  var tok=view('<a href="#/swipe" class="small">← '+esc(t("back"))+'</a><h1 style="margin-top:8px">'+categoryIcon(cat)+' '+esc(cat)+'</h1>'
    +'<label for="cat-sort">'+esc(t("sort"))+'</label><div class="seg" id="cat-sort"><button type="button" data-v="recommended" class="on">'+esc(t("sort_recommended"))+'</button><button type="button" data-v="newest">'+esc(t("sort_newest"))+'</button><button type="button" data-v="needs_most">'+esc(t("sort_needs_most"))+'</button></div>'
    +'<div id="cat-body" style="margin-top:10px">'+skeleton(2)+'</div>');
  var sort="recommended";
  $all("#cat-sort button").forEach(function(b){ b.onclick=function(){ sort=b.getAttribute("data-v"); $all("#cat-sort button").forEach(function(x){ x.classList.toggle("on", x===b); }); load(); }; });
  load();
  async function load(){
    var body=$("#cat-body"); if(!body) return;
    try{
      var d=await api("/feed?category="+encodeURIComponent(cat)+"&sort="+sort+"&limit=50");
      var list=pickList(d,["bills","feed"]);
      if(tok!==NAV) return;
      if(!list.length){ body.innerHTML=emptyState("🧾", t("no_bills_title"), t("no_bills_body"), '<a class="btn small" href="#/swipe">'+esc(t("go_swipe"))+'</a>'); return; }
      body.innerHTML='<p class="small">'+esc(t("search_results_count",{n:d.total!=null?d.total:list.length}))+'</p>'+list.map(function(b){ return listRowHtml(b); }).join("");
    }catch(e){ if(tok!==NAV) return; body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}
function renderBrowseTypes(){
  view('<h1>'+esc(t("browse_by_type"))+'</h1><p class="small">'+esc(t("browse_categories"))+'</p><div id="bt-body">'+skeleton(2)+'</div>');
  loadFacetCounts().then(function(){
    var body=$("#bt-body"); if(!body) return;
    var counts=S.facetCounts||{};
    var byCat=counts.byCategory||{};
    body.innerHTML='<div class="cat-grid" style="grid-template-columns:repeat(2,1fr)">'+BILL_TYPES.map(function(bt){
      var n=byCat[bt.cat]||0;
      return '<a class="card cat-tile" href="#/category/'+encodeURIComponent(bt.cat)+'"><span class="ic">'+bt.icon+'</span><span class="n">'+esc(t("billtype_"+bt.key))+'</span><span class="c">'+esc(t("billtype_desc_"+bt.key))+'</span><span class="c">'+esc(t("category_open_bills",{n:n}))+'</span></a>';
    }).join("")+'</div>';
  });
}

/* ---------- drafts + expired bills ---------- */
function renderDrafts(){
  if(!S.user){ view(emptyState("📝", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  view('<h1>'+esc(t("drafts_title"))+'</h1><div id="dr-body" style="margin-top:10px">'+skeleton(2)+'</div>');
  load();
  function load(){
    var body=$("#dr-body"); if(!body) return;
    var list=loadDrafts();
    if(!list.length){ body.innerHTML=emptyState("📝", t("drafts_empty"), "", '<a class="btn small" href="#/post">'+esc(t("post_first_bill"))+'</a>'); return; }
    body.innerHTML=list.map(function(d){
      var p=d.data||{};
      var ageDays=Math.floor((Date.now()-(d.updatedAt||Date.now()))/86400000);
      return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(p.title||t("draft"))+'</strong><span class="chip">'+esc(t("draft_complete",{n:draftCompletion(p)}))+'</span></div>'
        +'<p class="small">'+esc(p.category||"")+(p.amountRupees?' · '+esc(money(toMinor(p.amountRupees), curOf(S.user.country))):"")+' · '+esc(timeAgo(new Date(d.updatedAt).toISOString()))+'</p>'
        +(ageDays>=30?'<p class="small" style="color:var(--warn)">⚠️ '+esc(t("draft_age_warn",{n:ageDays}))+'</p>':"")
        +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
        +'<button class="btn small" data-dr="resume" data-id="'+esc(d.id)+'">'+esc(t("draft_resume"))+'</button>'
        +'<button class="btn secondary small" data-dr="dup" data-id="'+esc(d.id)+'">'+esc(t("draft_duplicate"))+'</button>'
        +'<button class="btn secondary small" data-dr="del" data-id="'+esc(d.id)+'">'+esc(t("remove"))+'</button></div></div>';
    }).join("");
    $all("[data-dr]", body).forEach(function(b){
      b.onclick=function(){
        var act=b.getAttribute("data-dr"), id=b.getAttribute("data-id");
        var list2=loadDrafts();
        var rec=list2.find(function(x){ return x.id===id; });
        if(act==="resume"&&rec){ S.post=rec.data; S.post.draftId=id; try{ localStorage.setItem("sp_post_draft", JSON.stringify(rec.data)); }catch(e){} go("#/post"); }
        if(act==="dup"&&rec){
          var copy=JSON.parse(JSON.stringify(rec.data));
          upsertDraft("d"+Date.now(), copy);
          toast(t("draft_duplicate")); load();
        }
        if(act==="del"){
          confirmDialog(t("discard_draft"), t("draft_discarded"), t("yes"), function(){
            saveDrafts(loadDrafts().filter(function(x){ return x.id!==id; }));
            load();
          });
        }
      };
    });
  }
}
function renderExpired(){
  if(!S.user){ view(emptyState("📁", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  view('<h1>'+esc(t("expired_title"))+'</h1><div id="ex-body" style="margin-top:10px">'+skeleton(2)+'</div>');
  load();
  async function load(){
    var body=$("#ex-body"); if(!body) return;
    try{
      var d=await api("/bills/mine?status=expired");
      var bills=pickList(d,["bills"]);
      if(!bills.length){ body.innerHTML=emptyState("⏳", t("expired_empty"), "", '<a class="btn small" href="#/mybills">'+esc(t("my_bills"))+'</a>'); return; }
      body.innerHTML=bills.map(function(b){
        var cur=b.currency||"NPR";
        var limitReached=(b.repostCount||0)>=3;
        return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(b.title||"")+'</strong>'+statusChip("expired")+'</div>'
          +'<p class="small">'+esc(b.request_code||b.requestCode||"")+' · '+esc(b.category||"")+' · '+esc(money(b.amount_minor||b.amountMinor||0,cur))+'</p>'
          + progressHtml(b)
          +'<p class="small">'+esc(t("repost_limit"))+': '+(b.repostCount||0)+'/3</p>'
          +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
          +'<a class="btn secondary small" href="#/bill/'+encodeURIComponent(b.id)+'">'+esc(t("view_bill"))+'</a>'
          +(limitReached?'':'<button class="btn small" data-ex="repost" data-id="'+esc(b.id)+'">'+esc(t("repost_btn"))+'</button>')
          +(limitReached?'':'<button class="btn secondary small" data-ex="edit" data-id="'+esc(b.id)+'">'+esc(t("repost_with_changes"))+'</button>')
          +'</div></div>';
      }).join("");
      $all("[data-ex]", body).forEach(function(btn){
        btn.onclick=async function(){
          var act=btn.getAttribute("data-ex"), id=btn.getAttribute("data-id");
          if(act==="edit"){ go("#/post?edit="+encodeURIComponent(id)); return; }
          btn.disabled=true;
          try{ await api("/bills/"+encodeURIComponent(id)+"/repost", {method:"POST"}); toast(t("repost_done")); load(); }
          catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
        };
      });
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}

/* ---------- gift journey (4 steps) ---------- */
function renderGift(billId, q){
  var direct=q&&q.direct==="1";
  var tok=view(skeleton(2));
  fetchBill(billId).then(function(bill){
    if(tok!==NAV) return;
    var cur=bill.currency||curOf(bill.country);
    var total=bill.amount_minor||bill.amountMinor||0, got=bill.covered_minor||bill.coveredMinor||0;
    var remaining=Math.max(0,total-got);
    var _gu=bill.user||bill.poster||{};
    var name=bill.anonymous? t("anonymous") : (_gu.display_name||_gu.displayName||bill.display_name||bill.displayName||(bill.user||{}).display_name||"");
    var g={bill:bill, step:1, amountMinor:0, tipMinor:0, tipChoice:"none", giftId:null, quote:null, payout:null, human:false, reference:"", direct:direct};
    S.gift=g;
    draw();
    function stepHead(){
      var steps=[t("amount_step"),t("check_step"),t("send_step"),t("confirmed_step")];
      return '<div class="step-dots">'+steps.map(function(s,i){ return '<i class="'+(i<g.step-1?"on":i===g.step-1?"on":"")+'"></i>'; }).join("")+'</div>'
        +'<p class="small" style="text-align:center">'+esc(t("gift_steps_label",{a:g.step}))+' — '+esc(steps[g.step-1])+'</p>';
    }
    function billCard(){
      return '<div class="card"><div class="name-row" style="display:flex;gap:10px;align-items:center"><div class="avatar">'+esc(initials(name))+'</div><div><strong>'+esc(name)+'</strong><div class="small">'+esc(bill.title||"")+' · '+flag(bill.country)+' '+esc(bill.city||"")+'</div></div></div>'+progressHtml(bill)+'</div>';
    }
    function draw(){
      if(g.step===1) drawAmount();
      else if(g.step===2) drawCheck();
      else if(g.step===3) drawSend();
      else drawConfirmed();
    }
    function drawAmount(){
      var chips=[10000,50000,100000];
      view(stepHead()+'<h1>'+esc(t("gift_amount_title"))+'</h1>'+billCard()+demoHtml()
        +(direct?'<div class="notice info" style="margin-top:10px">'+esc(t("direct_pay_note"))+'</div>':"")
        +'<div class="card" style="margin-top:12px"><label>'+esc(t("choose_amount"))+'</label>'
        +'<div class="grid2">'+chips.map(function(c){ return '<button type="button" class="btn secondary chip-amt" data-v="'+c+'">'+esc(money(c,cur))+'</button>'; }).join("")
        +'<button type="button" class="btn secondary chip-amt" data-v="'+remaining+'">'+esc(t("full_remaining"))+' ('+esc(money(remaining,cur))+')</button></div>'
        +'<label for="g-custom">'+esc(t("custom"))+' ('+esc(cur==="INR"?"₹":"रू")+')</label><input id="g-custom" type="number" inputmode="decimal" min="0" step="1" placeholder="'+esc(t("gift_amount_ph"))+'" aria-describedby="g-err">'
        +'<div class="field-err" id="g-err" role="alert"></div>'
        +'<p class="small">'+esc(t("gift_min_note",{n:money(1000,cur)}))+'</p>'
        +'<p id="g-after" class="small"></p>'
        +'<div class="btn-row"><a class="btn secondary" href="#/bill/'+encodeURIComponent(bill.id)+'">'+esc(t("back"))+'</a><button class="btn" id="g-next">'+esc(t("continue_btn"))+'</button></div></div>'
        +crossBorderHtml()+'<div style="margin-top:10px">'+feeSentenceHtml()+neverHoldsHtml()+'</div>');
      $all(".chip-amt").forEach(function(b){ b.onclick=function(){ g.amountMinor=parseInt(b.getAttribute("data-v"),10); $("#g-custom").value=fromMinor(g.amountMinor); updateAfter(); }; });
      $("#g-custom").addEventListener("input", function(){ g.amountMinor=toMinor($("#g-custom").value); updateAfter(); });
      function updateAfter(){
        if(g.amountMinor>0) $("#g-after").textContent=t("still_needed_after")+": "+money(Math.max(0,remaining-g.amountMinor),cur);
        else $("#g-after").textContent="";
      }
      $("#g-next").onclick=async function(){
        if(!needUser()) return;
        setFieldErr("g-custom","g-err","");
        if(g.amountMinor<=0){ setFieldErr("g-custom","g-err",t("amount_positive")); return; }
        if(g.amountMinor<1000){ setFieldErr("g-custom","g-err",t("amount_min",{n:money(1000,cur)})); return; }
        if(g.amountMinor>remaining && remaining>0){ setFieldErr("g-custom","g-err",t("amount_max",{n:money(remaining,cur)})); return; }
        var btn=$("#g-next"); btn.disabled=true; btn.textContent=t("loading");
        var op=NAV;
        try{
          try{ g.quote=await api("/gifts/quote", {method:"POST", body:{billId:bill.id, amountMinor:g.amountMinor}}); }
          catch(e){ g.quote=quoteLocal(g.amountMinor, cur, !!bill.charity); }
          if(op!==NAV) return;
          g.step=2; draw();
        }catch(e){ if(op!==NAV) return; btn.disabled=false; btn.textContent=t("continue_btn"); toast(e.message||t("fee_quote_failed"), true); }
      };
    }
    function drawCheck(){
      var q=g.quote||quoteLocal(g.amountMinor, cur, !!bill.charity);
      var fee=q.feeMinor!=null?q.feeMinor:0;
      var tip=g.tipMinor||0;
      var total=g.amountMinor+fee+tip;
      view(stepHead()+'<h1>'+esc(t("gift_check_title"))+'</h1>'+billCard()+demoHtml()
        +'<div class="card" style="margin-top:12px">'
        +'<div class="kv"><span>'+esc(t("your_help"))+' → '+esc(name)+'</span><b>'+esc(money(g.amountMinor,cur))+'</b></div>'
        +'<div class="kv"><span>'+esc(t("fee_label"))+'</span><b>'+esc(money(fee,cur))+'</b></div>'
        +'<div class="kv"><span>'+esc(t("tip_label"))+'</span><b>'+esc(money(tip,cur))+'</b></div>'
        +'<div class="kv"><span><strong>'+esc(t("total_send"))+'</strong></span><b>'+esc(money(total,cur))+'</b></div>'
        +'<p class="small" style="margin-top:10px">'+esc(t("fee_demo_note",{fee:money(fee,cur),amount:money(g.amountMinor,cur),name:name}))+'</p></div>'
        +feeSentenceHtml()
        +'<div class="card" style="margin-top:12px"><label>'+esc(t("tip_label"))+'</label>'
        +'<div class="seg" id="tip-seg"><button type="button" data-tip="none" class="'+(g.tipChoice==="none"?"on":"")+'">'+esc(t("no_tip"))+'</button><button type="button" data-tip="5" class="'+(g.tipChoice==="5"?"on":"")+'">5%</button><button type="button" data-tip="10" class="'+(g.tipChoice==="10"?"on":"")+'">10%</button><button type="button" data-tip="custom" class="'+(g.tipChoice==="custom"?"on":"")+'">'+esc(t("custom"))+'</button></div>'
        +'<div id="tip-custom-wrap" '+(g.tipChoice==="custom"?"":"hidden")+'>'+'<label for="tip-custom">'+esc(t("tip_custom"))+' ('+esc(cur==="INR"?"₹":"रू")+')</label><input id="tip-custom" type="number" min="0" step="1" value="'+(g.tipChoice==="custom"&&g.tipMinor?fromMinor(g.tipMinor):"")+'"></div>'
        +'<p class="small">'+esc(t("tip_separate"))+'</p></div>'
        +'<div class="card" style="margin-top:12px"><label class="check-row"><input type="checkbox" id="g-confirm-box"><span>'+esc(t("understand_gift"))+'</span></label>'
        +'<label class="check-row"><input type="checkbox" id="g-human"><span>'+esc(t("human_check"))+' — '+esc(t("turnstile_note"))+'</span></label>'
        +'<div class="field-err" id="g-err2" role="alert"></div>'
        +'<div class="btn-row"><button class="btn secondary" id="g-back">'+esc(t("back"))+'</button><button class="btn" id="g-to-send">'+esc(t("show_details"))+'</button></div></div>'
        +crossBorderHtml());
      $all("#tip-seg button").forEach(function(b){
        b.onclick=function(){
          $all("#tip-seg button").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on");
          var v=b.getAttribute("data-tip"); g.tipChoice=v;
          $("#tip-custom-wrap").hidden=v!=="custom";
          if(v==="5") g.tipMinor=Math.round(g.amountMinor*0.05);
          else if(v==="10") g.tipMinor=Math.round(g.amountMinor*0.10);
          else if(v==="none") g.tipMinor=0;
          drawCheck();
          if(v==="custom"){ var w=$("#tip-custom-wrap"); if(w) w.hidden=false; var inp=$("#tip-custom"); if(inp) inp.focus(); }
        };
      });
      var tc=$("#tip-custom"); if(tc) tc.addEventListener("input", function(){ g.tipMinor=toMinor(tc.value); });
      $("#g-back").onclick=function(){ g.step=1; draw(); };
      $("#g-to-send").onclick=async function(){
        if(!$("#g-confirm-box").checked){ $("#g-err2").textContent=t("confirm_checkbox_first"); return; }
        if(!$("#g-human").checked){ $("#g-err2").textContent=t("human_check_needed"); return; }
        g.human=true;
        var btn=$("#g-to-send"); btn.disabled=true; btn.textContent=t("loading");
        var op=NAV;
        try{
          var created=await api("/gifts", {method:"POST", body:{billId:bill.id, amountMinor:g.amountMinor, tipMinor:g.tipMinor||0}});
          g.giftId=created.id||created.giftId||(created.gift&&created.gift.id);
          var rev=await api("/gifts/"+encodeURIComponent(g.giftId)+"/reveal", {method:"POST"});
          // The server returns payoutMethods (array) + an optional payDirect block.
          g.payoutMethods=rev.payoutMethods||(rev.payoutMethod?[rev.payoutMethod]:(rev.payout?[rev.payout]:[]));
          g.payDirectInfo=rev.payDirect||null;
          g.payout=g.payoutMethods[0]||{};
          if(op!==NAV) return;
          g.step=3; draw();
        }catch(e){ if(op!==NAV) return; btn.disabled=false; btn.textContent=t("show_details"); toast(e.message||t("err_generic"), true); }
      };
    }
    function sendInstructions(method){
      var map={esewa:t("send_instructions_esewa"),khalti:t("send_instructions_khalti"),upi:t("send_instructions_upi"),bank_in:t("send_instructions_bank"),bank_np:t("send_instructions_bank"),connectips:t("send_instructions_connectips")};
      return map[method]||t("send_instructions_generic");
    }
    function drawSend(){
      var methods=g.payoutMethods&&g.payoutMethods.length?g.payoutMethods:(g.payout&&g.payout.method?[g.payout]:[]);
      var first=methods[0]||{};
      var method=(first.method||bill.payout_method||"").toLowerCase();
      var copyVal=first.account||first.accountNumber||first.number||first.vpa||first.upiId||"";
      var feeForSend=(g.quote&&g.quote.feeMinor!=null)?g.quote.feeMinor:quoteLocal(g.amountMinor,cur,!!bill.charity).feeMinor;
      function methodCard(p, idx){
        var m=(p.method||"").toLowerCase();
        var account=p.account||p.accountNumber||p.number||p.vpa||p.upiId||"";
        var holder=p.holderName||p.holder||p.accountHolder||"";
        var bank=p.bankName||p.bank||"";
        var branch=p.branch||"";
        var ifsc=p.ifsc||"";
        var link=p.link||p.paymentLink||(m==="payment_link"?account:"");
        var qr=p.qrUrl||(m==="fonepay_qr"?account:"");
        return '<div class="card" style="margin-top:12px"><p class="small">'+esc(t("details_shown"))+(methods.length>1?" ("+(idx+1)+"/"+methods.length+")":"")+'</p>'
          +'<div class="kv"><span>'+esc(t("payout_hint"))+'</span><b>'+esc(m||"—")+'</b></div>'
          +(account&&m!=="payment_link"&&m!=="fonepay_qr"?'<div class="kv"><span>'+esc(t("account_no"))+'</span><b class="money">'+esc(account)+'</b></div>':"")
          +(holder?'<div class="kv"><span>'+esc(t("holder_name"))+'</span><b>'+esc(holder)+'</b></div>':"")
          +(bank?'<div class="kv"><span>'+esc(t("bank_name"))+'</span><b>'+esc(bank)+'</b></div>':"")
          +(branch?'<div class="kv"><span>'+esc(t("branch"))+'</span><b>'+esc(branch)+'</b></div>':"")
          +(ifsc?'<div class="kv"><span>'+esc(t("ifsc"))+'</span><b>'+esc(ifsc)+'</b></div>':"")
          +(link?'<div class="kv"><span>'+esc(t("payment_link"))+'</span><b><a href="'+esc(link)+'" target="_blank" rel="noopener">'+esc(t("open_cta"))+'</a></b></div>':"")
          +(qr?'<div style="text-align:center;margin:8px 0"><img src="'+esc(qr)+'" alt="'+esc(t("qr_alt"))+'" style="max-width:220px;border-radius:12px"></div>':"")
          +'<div class="kv"><span>'+esc(t("you_send"))+'</span><b>'+esc(money(g.amountMinor,cur))+'</b></div>'
          +(account?'<div class="btn-row"><button class="btn secondary" data-copy="'+esc(account)+'">'+esc(t("copy_number"))+'</button></div>':"")
          +'<p style="margin-top:12px">'+esc(sendInstructions(m))+'</p>'
          +'<p class="small">⚠️ '+esc(t("never_share_mpin"))+'</p>'
          +'<p class="small muted">'+esc(t("payout_revealed_log"))+'</p></div>';
      }
      var pd=g.payDirectInfo;
      view(stepHead()+'<h1>'+esc(t("gift_send_title"))+'</h1>'+billCard()+demoHtml()
        +(methods.length? methods.map(methodCard).join("") : '<div class="card" style="margin-top:12px"><p>'+esc(t("no_payout_methods"))+'</p></div>')
        +'<p class="small" style="text-align:center;margin-top:10px">'+esc(t("fee_demo_note",{fee:money(feeForSend,cur),amount:money(g.amountMinor,cur),name:name}))+'</p>'
        +(pd?'<div class="card" style="margin-top:12px"><h2>'+esc(t("pay_direct"))+'</h2>'
          +'<div class="kv"><span>'+esc(t("biller"))+'</span><b>'+esc(pd.billerName||"")+'</b></div>'
          +(pd.billerRef?'<div class="kv"><span>'+esc(t("reference_label"))+'</span><b>'+esc(pd.billerRef)+'</b></div>':"")
          +(pd.billerDestination?'<div class="kv"><span>'+esc(t("biller_destination"))+'</span><b>'+esc(pd.billerDestination)+'</b></div>':"")
          +'<p class="small">'+esc(t("pay_biller_steps"))+'</p></div>':"")
        +crossBorderHtml()
        +'<div class="card" style="margin-top:12px"><label for="g-ref">'+esc(t("reference_opt"))+'</label><input id="g-ref" maxlength="80">'
        +'<div class="btn-row"><button class="btn" id="g-sent">'+esc(t("i_sent_it"))+'</button></div>'
        +'<button class="btn ghost" id="g-cancel">'+esc(t("couldnt_send"))+'</button></div>');
      $all("[data-copy]").forEach(function(b){ b.onclick=function(){ copyText(b.getAttribute("data-copy")||"", t("copied")); }; });
      var gc=$("#g-copy"); if(gc) gc.onclick=function(){ copyText(copyVal, t("copied")); };
      $("#g-sent").onclick=async function(){
        var btn=$("#g-sent"); btn.disabled=true; btn.textContent=t("loading");
        var op=NAV;
        try{
          await api("/gifts/"+encodeURIComponent(g.giftId)+"/reported-sent", {method:"POST", body:{reference:$("#g-ref").value.trim()||undefined}});
          if(op!==NAV) return;
          g.step=4; draw();
        }catch(e){ if(op!==NAV) return; btn.disabled=false; btn.textContent=t("i_sent_it"); toast(e.message||t("err_generic"), true); }
      };
      $("#g-cancel").onclick=function(){
        confirmDialog(t("couldnt_send"), t("send_failed_note"), t("yes"), function(){ go("#/bill/"+encodeURIComponent(bill.id)); });
      };
    }
    function drawConfirmed(){
      view(stepHead()+'<div class="center-page"><div class="slide-ic">💙</div><h1>'+esc(t("thanks_helping",{name:name}))+'</h1>'
        +'<p>'+esc(t("recipient_confirm_pending"))+'</p><p class="small">'+esc(t("waiting_confirm"))+'</p>'
        +'<div style="width:100%;max-width:360px;display:grid;gap:10px"><a class="btn" href="#/founder-tip?gift='+encodeURIComponent(g.giftId||"")+'&amount='+g.amountMinor+'&currency='+cur+'">'+esc(t("founder_tip_title"))+'</a>'
        +'<a class="btn secondary" href="#/swipe">'+esc(t("continue_helping"))+'</a>'
        +'<a class="btn secondary" href="#/mybills">'+esc(t("my_bills"))+'</a></div></div>');
    }
  }).catch(function(e){
    if(tok!==NAV) return;
    view(emptyState("🧾", t("bill_not_found"), e.message||"", '<a class="btn small" href="#/swipe">'+esc(t("go_swipe"))+'</a>', "h1"));
  });
}

/* ---------- post flow (6 steps) ---------- */
function blankPost(){
  return {step:1, title:"", category:"", company:"", amountRupees:"", coveredRupees:"", dueDate:"", city:"",
    story:"", details:"", charity:false, charityDesc:"",
    photoFile:null, photoDataUrl:null, photoUrl:null, redactRects:[], redactConfirmed:false, redactedDataUrl:null,
    privateProofFile:null, privateProofUrl:null, supportFile:null, supportDataUrl:null, supportUrl:null,
    anonymous:false, payouts:[], payDirect:false, billerName:"", billerRef:"", billerDest:"",
    verif:{bill:false,id:false,name:false,biller:false}, idFile:null, idUrl:null, billId:null, requestCode:null};
}
function loadDraft(){
  try{
    var d=JSON.parse(localStorage.getItem("sp_post_draft")||"null");
    if(d){ var b=blankPost(); Object.keys(d).forEach(function(k){ if(k!=="photoFile"&&k!=="privateProofFile"&&k!=="supportFile"&&k!=="idFile") b[k]=d[k]; }); return b; }
  }catch(e){}
  return blankPost();
}
function saveDraft(p){
  try{
    var c={}; Object.keys(p).forEach(function(k){ if(["photoFile","privateProofFile","supportFile","idFile"].indexOf(k)<0) c[k]=p[k]; });
    localStorage.setItem("sp_post_draft", JSON.stringify(c));
  }catch(e){}
}
function renderPost(){
  if(!S.user){ view(emptyState("📝", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  var p=S.post||loadDraft();
  S.post=p;
  if(!p.city) p.city=S.user.city||"";
  var cur=curOf(S.user.country);
  var stepNames=[t("step1"),t("step2"),t("step3"),t("step4"),t("step5"),t("step6")];
  draw();
  function head(){
    return '<div class="step-dots">'+stepNames.map(function(s,i){ return '<i class="'+(i<p.step-1?"on":i===p.step-1?"on":"")+'"></i>'; }).join("")+'</div>'
      +'<p class="small" style="text-align:center">'+esc(t("step_of",{a:p.step,b:6}))+' — '+esc(stepNames[p.step-1])+'</p>'
      +'<div class="progress"><i style="width:'+(p.step/6*100)+'%"></i></div>';
  }
  function nav(prevOk, nextLabel, onNext, showDiscard){
    return '<div class="btn-row">'
      +(prevOk?'<button class="btn secondary" id="p-back">'+esc(t("back"))+'</button>':"")
      +'<button class="btn" id="p-next">'+esc(nextLabel||t("next"))+'</button></div>'
      +(showDiscard?'<button class="btn ghost" id="p-discard">'+esc(t("discard_draft"))+'</button>':"");
  }
  function bindNav(prevFn, nextFn){
    var b=$("#p-back"); if(b) b.onclick=function(){ saveDraft(p); prevFn(); };
    var n=$("#p-next"); if(n) n.onclick=function(){ saveDraft(p); nextFn(); };
    var d=$("#p-discard"); if(d) d.onclick=function(){ confirmDialog(t("discard_draft"), t("draft_discarded"), t("yes"), function(){ try{ localStorage.removeItem("sp_post_draft"); }catch(e){} S.post=blankPost(); renderPost(); }); };
  }
  function draw(){
    saveDraft(p);
    if(p.step===1) draw1();
    else if(p.step===2) draw2();
    else if(p.step===3) draw3();
    else if(p.step===4) draw4();
    else if(p.step===5) draw5();
    else draw6();
  }
  function draw1(){
    var cats=I.categories();
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<p class="small">'+esc(t("privacy_note_forms"))+'</p><p class="small">'+esc(t("required_note"))+'</p>'
      +'<div class="card" style="margin-top:10px">'
      +'<label for="f-title">'+esc(t("title_label"))+' '+reqStar()+'</label><input id="f-title" maxlength="80" value="'+esc(p.title)+'" aria-required="true" aria-describedby="e-title"><div class="field-err" id="e-title" role="alert"></div>'
      +'<label id="lbl-cat">'+esc(t("category"))+' '+reqStar()+'</label><div id="f-cats" role="group" aria-labelledby="lbl-cat" style="display:flex;flex-wrap:wrap;gap:6px">'+cats.map(function(c){ return '<button type="button" class="chip'+(p.category===c?" on":"")+'" data-cat="'+esc(c)+'" aria-pressed="'+(p.category===c?"true":"false")+'">'+esc(c)+'</button>'; }).join("")+'</div><div class="field-err" id="e-cat" role="alert"></div>'
      +'<label for="f-company">'+esc(t("biller"))+'</label><input id="f-company" maxlength="120" value="'+esc(p.company)+'">'
      +'<label for="f-amount">'+esc(t("amount_label"))+' '+reqStar()+' ('+esc(cur==="INR"?"₹":"रू")+' '+cur+')</label><input id="f-amount" type="number" inputmode="decimal" min="0" step="1" value="'+esc(p.amountRupees)+'" aria-required="true" aria-describedby="e-amount"><div class="field-err" id="e-amount" role="alert"></div>'
      +'<label for="f-covered">'+esc(t("covered_label"))+' ('+esc(cur==="INR"?"₹":"रू")+')</label><input id="f-covered" type="number" inputmode="decimal" min="0" step="1" value="'+esc(p.coveredRupees)+'">'
      +'<label for="f-due">'+esc(t("due_date"))+'</label><input id="f-due" type="date" value="'+esc(p.dueDate)+'">'
      +'<label for="f-city">'+esc(t("city"))+'</label><input id="f-city" maxlength="80" value="'+esc(p.city)+'" autocomplete="address-level2">'
      +'<label for="f-story">'+esc(t("short_story"))+' '+reqStar()+' <span class="small muted">(<span id="story-n">'+p.story.length+'</span>/280)</span></label><textarea id="f-story" maxlength="280" placeholder="'+esc(t("story_hint"))+'" aria-required="true" aria-describedby="e-story">'+esc(p.story)+'</textarea><div class="field-err" id="e-story" role="alert"></div>'
      +'<label for="f-details">'+esc(t("long_story"))+'</label><textarea id="f-details" maxlength="1500">'+esc(p.details)+'</textarea>'
      +'<label class="check-row"><input type="checkbox" id="f-charity" '+(p.charity?"checked":"")+'> '+esc(t("charity_toggle"))+'</label>'
      +'<div id="charity-wrap" '+(p.charity?"":"hidden")+'><label>'+esc(t("charity_desc"))+'</label><input id="f-charity-desc" maxlength="200" value="'+esc(p.charityDesc)+'"></div>'
      +'</div>'+nav(false, t("next"), null, true));
    $all("#f-cats .chip").forEach(function(b){ b.onclick=function(){ p.category=b.getAttribute("data-cat"); $all("#f-cats .chip").forEach(function(x){ x.classList.toggle("on", x===b); x.setAttribute("aria-pressed", x===b?"true":"false"); }); }; });
    $("#f-story").addEventListener("input", function(){ $("#story-n").textContent=String($("#f-story").value.length); });
    $("#f-charity").addEventListener("change", function(){ $("#charity-wrap").hidden=!$("#f-charity").checked; });
    bindNav(null, function(){
      p.title=$("#f-title").value.trim(); p.company=$("#f-company").value.trim();
      p.amountRupees=$("#f-amount").value; p.coveredRupees=$("#f-covered").value;
      p.dueDate=$("#f-due").value; p.city=$("#f-city").value.trim();
      p.story=$("#f-story").value.trim(); p.details=$("#f-details").value.trim();
      p.charity=$("#f-charity").checked; p.charityDesc=$("#f-charity-desc")?$("#f-charity-desc").value.trim():"";
      var ok=true;
      setFieldErr("f-title","e-title",""); $("#e-cat").textContent=""; setFieldErr("f-amount","e-amount",""); setFieldErr("f-story","e-story","");
      if(!p.title){ setFieldErr("f-title","e-title",t("missing_title")); ok=false; }
      if(!p.category){ $("#e-cat").textContent=t("missing_category"); ok=false; }
      if(toMinor(p.amountRupees)<=0){ setFieldErr("f-amount","e-amount",t("missing_amount")); ok=false; }
      if(!p.story){ setFieldErr("f-story","e-story",t("missing_story")); ok=false; }
      if(!ok) return;
      p.step=2; draw();
    });
  }
  function fileInput(id, accept, label){
    return '<input type="file" id="'+id+'" accept="'+accept+'" aria-label="'+esc(label)+'" style="margin:6px 0">';
  }
  function draw2(){
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<div class="card" style="margin-top:10px"><h2>'+esc(t("public_photo"))+'</h2><p class="small">'+esc(t("photo_tips"))+'</p>'
      +fileInput("f-photo","image/jpeg,image/png,image/webp", t("public_photo"))
      +'<div id="photo-preview"></div><div id="redact-area"></div>'
      +'<h3 style="margin-top:16px">'+esc(t("private_proof"))+'</h3><p class="small">'+esc(t("private_proof_note"))+'</p>'
      +fileInput("f-proof","image/jpeg,image/png,image/webp,application/pdf", t("private_proof"))
      +'<div id="proof-state" class="small">'+(p.privateProofUrl?esc(t("doc_uploaded")):"")+'</div>'
      +'<h3 style="margin-top:16px">'+esc(t("support_photo"))+'</h3>'
      +fileInput("f-support","image/jpeg,image/png,image/webp", t("support_photo"))
      +'<div id="support-preview"></div></div>'
      +nav(true, t("next"), null, true));
    if(p.photoDataUrl) showRedactor();
    if(p.supportDataUrl) $("#support-preview").innerHTML='<img class="bill-photo" src="'+p.supportDataUrl+'" alt="">';
    $("#f-photo").addEventListener("change", function(e){
      var f=e.target.files[0]; if(!f) return;
      if(f.size>5*1024*1024){ toast(t("file_too_big"), true); return; }
      p.photoFile=f; p.redactRects=[]; p.redactConfirmed=false; p.redactedDataUrl=null;
      var r=new FileReader(); r.onload=function(){ p.photoDataUrl=r.result; saveDraft(p); showRedactor(); }; r.readAsDataURL(f);
    });
    $("#f-proof").addEventListener("change", async function(e){
      var f=e.target.files[0]; if(!f) return;
      if(f.size>5*1024*1024){ toast(t("file_too_big"), true); return; }
      p.privateProofFile=f;
      $("#proof-state").textContent=t("loading");
      try{ var up=await uploadFile(f,"private_proof"); p.privateProofUrl=up.url||up.fileUrl||up.path; $("#proof-state").textContent=t("doc_uploaded"); saveDraft(p); }
      catch(err){ $("#proof-state").textContent=""; toast(err.message||t("upload_failed"), true); }
    });
    $("#f-support").addEventListener("change", function(e){
      var f=e.target.files[0]; if(!f) return;
      if(f.size>5*1024*1024){ toast(t("file_too_big"), true); return; }
      p.supportFile=f;
      var r=new FileReader(); r.onload=function(){ p.supportDataUrl=r.result; $("#support-preview").innerHTML='<img class="bill-photo" src="'+r.result+'" alt="">'; saveDraft(p); }; r.readAsDataURL(f);
    });
    function showRedactor(){
      var area=$("#redact-area"); if(!area) return;
      area.innerHTML='<h3 style="margin-top:14px">'+esc(t("redact_title"))+'</h3><p class="small">'+esc(t("redact_body"))+'</p><p class="small">'+esc(t("drag_redact"))+'</p>'
        +'<div class="redact-wrap"><canvas id="redact-canvas"></canvas></div>'
        +'<div class="btn-row"><button class="btn secondary small" id="rd-clear">'+esc(t("clear_redactions"))+'</button><button class="btn small" id="rd-confirm">'+esc(t("confirm_public"))+'</button></div>'
        +'<p class="small" id="rd-state">'+(p.redactConfirmed?"✓ "+esc(t("redact_done")):"")+'</p>';
      var canvas=$("#redact-canvas"), ctx=canvas.getContext("2d");
      var img=new Image();
      img.onload=function(){
        var maxW=560; var scale=Math.min(1, maxW/img.naturalWidth);
        canvas.width=Math.round(img.naturalWidth*scale); canvas.height=Math.round(img.naturalHeight*scale);
        drawCanvas();
      };
      img.src=p.photoDataUrl;
      function drawCanvas(){
        ctx.drawImage(img,0,0,canvas.width,canvas.height);
        ctx.fillStyle="#000";
        p.redactRects.forEach(function(r){ ctx.fillRect(r.x,r.y,r.w,r.h); });
      }
      var drawing=null;
      function pos(e){
        var r=canvas.getBoundingClientRect();
        var cx=(e.touches?e.touches[0].clientX:e.clientX), cy=(e.touches?e.touches[0].clientY:e.clientY);
        return {x:(cx-r.left)*(canvas.width/r.width), y:(cy-r.top)*(canvas.height/r.height)};
      }
      canvas.addEventListener("pointerdown", function(e){ e.preventDefault(); drawing={start:pos(e)}; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener("pointermove", function(e){
        if(!drawing) return;
        var pt=pos(e); var s=drawing.start;
        drawing.rect={x:Math.min(s.x,pt.x), y:Math.min(s.y,pt.y), w:Math.abs(pt.x-s.x), h:Math.abs(pt.y-s.y)};
        drawCanvas(); ctx.fillStyle="#000"; ctx.fillRect(drawing.rect.x,drawing.rect.y,drawing.rect.w,drawing.rect.h);
      });
      canvas.addEventListener("pointerup", function(){
        if(drawing&&drawing.rect&&drawing.rect.w>6&&drawing.rect.h>6){ p.redactRects.push(drawing.rect); p.redactConfirmed=false; $("#rd-state").textContent=""; saveDraft(p); }
        drawing=null; drawCanvas();
      });
      $("#rd-clear").onclick=function(){ p.redactRects=[]; p.redactConfirmed=false; p.redactedDataUrl=null; $("#rd-state").textContent=""; drawCanvas(); saveDraft(p); };
      $("#rd-confirm").onclick=function(){
        drawCanvas();
        p.redactedDataUrl=canvas.toDataURL("image/jpeg", 0.85);
        p.redactConfirmed=true;
        $("#rd-state").textContent="✓ "+t("redact_done");
        toast(t("redact_done")); saveDraft(p);
      };
    }
    bindNav(function(){ p.step=1; draw(); }, function(){
      if(p.photoDataUrl && !p.redactConfirmed){ toast(t("photo_required_redact"), true); return; }
      p.step=3; draw();
    });
  }
  function draw3(){
    var u=S.user;
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<div class="card" style="margin-top:10px"><p>'+esc(t("profile_confirm"))+'</p>'
      +'<div class="row-card card"><div class="avatar">'+(u.photo_url||u.photoUrl?'<img src="'+esc(u.photo_url||u.photoUrl)+'" alt="">':esc(initials(u.display_name||u.displayName)))+'</div>'
      +'<div class="grow"><div class="t">'+esc(u.display_name||u.displayName||"")+'</div><div class="s">@'+esc(u.username||"")+' · '+flag(u.country)+' '+esc(p.city||u.city||"")+'</div></div></div>'
      +'<p class="small">'+esc(u.about||"")+'</p>'
      +'<label class="check-row"><input type="checkbox" id="f-anon" '+(p.anonymous?"checked":"")+'> '+esc(t("anonymous_post"))+'</label>'
      +'<p class="small"><a href="#/settings">'+esc(t("edit_profile"))+'</a> · '+esc(t("profile_photo_review"))+'</p></div>'
      +nav(true, t("next"), null, true));
    bindNav(function(){ p.step=2; draw(); }, function(){ p.anonymous=$("#f-anon").checked; p.step=4; draw(); });
  }
  function payoutFormHtml(idx){
    var methods=payoutMethodsFor(S.user.country);
    var po=p.payouts[idx]||{method:methods[0].id, account:"", holder:"", bank:"", ifsc:"", branch:"", qrUrl:""};
    var m=po.method;
    var h='<div class="card" style="margin-top:10px" data-payout="'+idx+'"><div style="display:flex;justify-content:space-between;align-items:center"><strong>'+esc(t("payout_hint"))+' '+(idx+1)+'</strong>'
      +'<button type="button" class="btn ghost small" data-remove-payout="'+idx+'">✕ '+esc(t("remove"))+'</button></div>'
      +'<label for="po-'+idx+'-method">'+esc(t("payment_methods"))+'</label><select id="po-'+idx+'-method" data-f="method">'+methods.map(function(mm){ return '<option value="'+mm.id+'" '+(m===mm.id?"selected":"")+'>'+esc(mm.label)+'</option>'; }).join("")+'</select>';
    if(m==="esewa") h+='<label for="po-'+idx+'-account">'+esc(t("esewa_no"))+'</label><input id="po-'+idx+'-account" data-f="account" type="tel" inputmode="numeric" autocomplete="tel" maxlength="10" value="'+esc(po.account)+'" placeholder="98XXXXXXXX">';
    else if(m==="khalti") h+='<label for="po-'+idx+'-account">'+esc(t("khalti_no"))+'</label><input id="po-'+idx+'-account" data-f="account" type="tel" inputmode="numeric" autocomplete="tel" maxlength="10" value="'+esc(po.account)+'" placeholder="98XXXXXXXX">';
    else if(m==="upi") h+='<label for="po-'+idx+'-account">'+esc(t("upi_id"))+'</label><input id="po-'+idx+'-account" data-f="account" value="'+esc(po.account)+'" placeholder="name@okhdfc">';
    else if(m==="payment_link") h+='<label for="po-'+idx+'-account">'+esc(t("payment_link"))+'</label><input id="po-'+idx+'-account" data-f="account" value="'+esc(po.account)+'" placeholder="https://…">';
    else if(m==="fonepay_qr") h+='<label for="po-'+idx+'-qrfile">'+esc(t("fonepay_qr"))+'</label><input type="file" id="po-'+idx+'-qrfile" data-f="qrfile" accept="image/jpeg,image/png,image/webp"><p class="small">'+(po.qrUrl?esc(t("doc_uploaded")):"")+'</p>';
    else {
      h+='<label for="po-'+idx+'-bank">'+esc(t("bank_name"))+'</label><input id="po-'+idx+'-bank" data-f="bank" value="'+esc(po.bank)+'">'
        +'<label for="po-'+idx+'-account">'+esc(t("account_no"))+'</label><input id="po-'+idx+'-account" data-f="account" inputmode="numeric" value="'+esc(po.account)+'">';
      if(m==="bank_in") h+='<label for="po-'+idx+'-ifsc">'+esc(t("ifsc"))+'</label><input id="po-'+idx+'-ifsc" data-f="ifsc" value="'+esc(po.ifsc)+'" placeholder="SBIN0001234" style="text-transform:uppercase">';
      h+='<label for="po-'+idx+'-branch">'+esc(t("branch"))+'</label><input id="po-'+idx+'-branch" data-f="branch" value="'+esc(po.branch)+'">';
    }
    if(m!=="fonepay_qr"&&m!=="payment_link") h+='<label for="po-'+idx+'-holder">'+esc(t("holder_name"))+'</label><input id="po-'+idx+'-holder" data-f="holder" autocomplete="name" value="'+esc(po.holder)+'">';
    h+='<div class="field-err" data-err role="alert"></div></div>';
    return h;
  }
  function draw4(){
    if(p.payouts.length===0) p.payouts=[{method:payoutMethodsFor(S.user.country)[0].id, account:"", holder:"", bank:"", ifsc:"", branch:"", qrUrl:""}];
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<div class="card" style="margin-top:10px"><h2>'+esc(t("payout_step_title"))+'</h2><p>'+esc(t("payout_step_body"))+'</p><p class="small">'+esc(t("privacy_note_forms"))+'</p>'
      +'<div id="payout-list">'+p.payouts.map(function(_,i){ return payoutFormHtml(i); }).join("")+'</div>'
      +'<button class="btn secondary small" id="add-payout" style="margin-top:10px">＋ '+esc(t("payout_hint"))+'</button>'
      +'<label class="check-row" style="margin-top:14px"><input type="checkbox" id="f-pd" '+(p.payDirect?"checked":"")+'> '+esc(t("pay_direct_opt"))+'</label>'
      +'<div id="pd-wrap" '+(p.payDirect?"":"hidden")+'>'
      +'<label for="f-biller">'+esc(t("biller"))+'</label><input id="f-biller" value="'+esc(p.billerName)+'">'
      +'<label for="f-bref">'+esc(t("biller_ref"))+'</label><input id="f-bref" value="'+esc(p.billerRef)+'">'
      +'<label for="f-bdest">'+esc(t("biller_dest"))+'</label><input id="f-bdest" value="'+esc(p.billerDest)+'" placeholder="https://…">'
      +'<p class="small">'+esc(t("direct_pay_note"))+'</p></div>'
      +'<label class="check-row"><input type="checkbox" id="f-belongs"> '+esc(t("payout_belongs"))+'</label>'
      +'<div class="field-err" id="e-payout" role="alert"></div></div>'
      +nav(true, t("next"), null, true));
    function collect(){
      $all("[data-payout]").forEach(function(card){
        var i=parseInt(card.getAttribute("data-payout"),10);
        var po=p.payouts[i]||{};
        $all("[data-f]", card).forEach(function(inp){
          var k=inp.getAttribute("data-f");
          if(k!=="qrfile") po[k]=inp.value;
        });
        p.payouts[i]=po;
      });
      p.payDirect=$("#f-pd").checked;
      p.billerName=$("#f-biller")?$("#f-biller").value.trim():"";
      p.billerRef=$("#f-bref")?$("#f-bref").value.trim():"";
      p.billerDest=$("#f-bdest")?$("#f-bdest").value.trim():"";
    }
    $all("[data-payout] select[data-f=method]").forEach(function(sel){
      sel.addEventListener("change", function(){ collect(); draw4(); });
    });
    $all("[data-remove-payout]").forEach(function(b){
      b.onclick=function(){ collect(); p.payouts.splice(parseInt(b.getAttribute("data-remove-payout"),10),1); if(p.payouts.length===0) p.payouts=[{method:payoutMethodsFor(S.user.country)[0].id, account:"", holder:"", bank:"", ifsc:"", branch:"", qrUrl:""}]; draw4(); };
    });
    $all("[data-f=qrfile]").forEach(function(inp){
      inp.addEventListener("change", async function(){
        var f=inp.files[0]; if(!f) return;
        var card=inp.closest("[data-payout]"); var i=parseInt(card.getAttribute("data-payout"),10);
        try{ var up=await uploadFile(f,"qr"); p.payouts[i].qrUrl=up.url||up.fileUrl||up.path; toast(t("doc_uploaded")); saveDraft(p); }
        catch(e){ toast(e.message||t("upload_failed"), true); }
      });
    });
    $("#add-payout").onclick=function(){ collect(); p.payouts.push({method:payoutMethodsFor(S.user.country)[0].id, account:"", holder:"", bank:"", ifsc:"", branch:"", qrUrl:""}); draw4(); };
    $("#f-pd").addEventListener("change", function(){ $("#pd-wrap").hidden=!$("#f-pd").checked; });
    bindNav(function(){ collect(); p.step=3; draw(); }, function(){
      collect();
      $("#e-payout").textContent="";
      if(!$("#f-belongs").checked){ $("#e-payout").textContent=t("payout_belongs"); return; }
      var ok=true;
      $all("[data-payout]").forEach(function(card){
        var i=parseInt(card.getAttribute("data-payout"),10);
        var err=validatePayout(p.payouts[i].method, p.payouts[i]);
        var errEl=card.querySelector("[data-err]");
        if(err){ errEl.textContent=err; ok=false; } else errEl.textContent="";
      });
      if(p.payDirect && (!p.billerName || !p.billerDest)){ $("#e-payout").textContent=t("err_required"); ok=false; }
      if(!ok) return;
      p.step=5; draw();
    });
  }
  function draw5(){
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<div class="card" style="margin-top:10px"><p>'+esc(t("verification_optional"))+'</p>'
      +'<label class="check-row"><input type="checkbox" id="v-bill" '+(p.verif.bill?"checked":"")+'> <span><strong>'+esc(t("verify_bill"))+'</strong><br><span class="small">'+esc(t("verify_bill_help"))+'</span></span></label>'
      +'<label class="check-row"><input type="checkbox" id="v-id" '+(p.verif.id?"checked":"")+'> <span><strong>'+esc(t("verify_id"))+'</strong><br><span class="small">'+esc(t("verify_id_help"))+'</span></span></label>'
      +'<div id="id-wrap" '+(p.verif.id?"":"hidden")+'><label for="f-id">'+esc(t("id_doc"))+'</label><p class="small">'+esc(t("id_hint"))+'</p><input type="file" id="f-id" accept="image/jpeg,image/png,image/webp,application/pdf"><div class="small" id="id-state">'+(p.idUrl?esc(t("doc_uploaded")):"")+'</div></div>'
      +'<label class="check-row"><input type="checkbox" id="v-name" '+(p.verif.name?"checked":"")+'> <span><strong>'+esc(t("verify_name"))+'</strong><br><span class="small">'+esc(t("verify_name_help"))+'</span></span></label>'
      +'<label class="check-row"><input type="checkbox" id="v-biller" '+(p.verif.biller?"checked":"")+'> <span><strong>'+esc(t("verify_biller"))+'</strong><br><span class="small">'+esc(t("verify_biller_help"))+'</span></span></label>'
      +'<p class="small">'+esc(t("private_proof_note"))+'</p></div>'
      +nav(true, t("next"), null, true));
    $("#v-id").addEventListener("change", function(){ $("#id-wrap").hidden=!$("#v-id").checked; });
    var fi=$("#f-id");
    if(fi) fi.addEventListener("change", async function(){
      var f=fi.files[0]; if(!f) return;
      if(f.size>5*1024*1024){ toast(t("file_too_big"), true); return; }
      $("#id-state").textContent=t("loading");
      try{ var up=await uploadFile(f,"id_doc"); p.idUrl=up.url||up.fileUrl||up.path; $("#id-state").textContent=t("doc_uploaded"); saveDraft(p); }
      catch(e){ $("#id-state").textContent=""; toast(e.message||t("upload_failed"), true); }
    });
    bindNav(function(){ collectV(); p.step=4; draw(); }, function(){ collectV(); p.step=6; draw(); });
    function collectV(){ p.verif={bill:$("#v-bill").checked, id:$("#v-id").checked, name:$("#v-name").checked, biller:$("#v-biller").checked}; }
  }
  function draw6(){
    var cur2=cur;
    var hints=p.payouts.map(function(po){ return maskedHint(po.method, po.account||po.qrUrl||""); }).join(" · ");
    view('<h1>'+esc(t("post_title"))+'</h1>'+head()
      +'<p>'+esc(t("final_preview"))+'</p>'
      +'<div class="card"><h2>'+esc(p.title)+'</h2><p><span class="money" style="font-size:20px;font-weight:800">'+esc(money(toMinor(p.amountRupees),cur2))+'</span> · '+esc(p.category)+'</p>'
      +(p.redactedDataUrl?'<img class="bill-photo" src="'+p.redactedDataUrl+'" alt="">':(p.photoDataUrl?'<img class="bill-photo" src="'+p.photoDataUrl+'" alt="">':""))
      +'<p>'+esc(p.story)+'</p>'+(p.details?'<p>'+esc(p.details)+'</p>':"")
      +'<div class="kv"><span>'+esc(t("biller"))+'</span><b>'+esc(p.company||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("due_date"))+'</span><b>'+esc(p.dueDate||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("city"))+'</span><b>'+esc(p.city)+'</b></div>'
      +'<div class="kv"><span>'+esc(t("payout_hint"))+'</span><b>'+esc(hints||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("charity_only"))+'</span><b>'+(p.charity?t("yes")+" — "+esc(p.charityDesc):t("no"))+'</b></div>'
      +'<div class="kv"><span>'+esc(t("pay_direct"))+'</span><b>'+(p.payDirect?t("yes")+" — "+esc(p.billerName):t("no"))+'</b></div>'
      +'<div class="kv"><span>'+esc(t("verify_centre"))+'</span><b>'+(["bill","id","name","biller"].filter(function(k){ return p.verif[k]; }).map(function(k){ return {bill:t("verify_bill"),id:t("verify_id"),name:t("verify_name"),biller:t("verify_biller")}[k]; }).join(", ")||"—")+'</b></div></div>'
      +'<div class="notice info" style="margin-top:12px">'+esc(t("owner_approval_note"))+'</div>'
      +'<div class="field-err" id="e-submit" role="alert"></div>'
      +nav(true, t("submit_approval"), null, true));
    bindNav(function(){ p.step=5; draw(); }, async function(){
      var btn=$("#p-next"); btn.disabled=true; btn.textContent=t("loading");
      var op=NAV;
      try{
        if(p.redactedDataUrl && !p.photoUrl){
          var blob=await (await fetch(p.redactedDataUrl)).blob();
          var file=new File([blob], "bill-public.jpg", {type:"image/jpeg"});
          var up=await uploadFile(file,"public_bill");
          p.photoUrl=up.url||up.fileUrl||up.path;
        }
        if(p.supportFile && !p.supportUrl){
          var up2=await uploadFile(p.supportFile,"support");
          p.supportUrl=up2.url||up2.fileUrl||up2.path;
        }
        var payload={
          title:p.title, category:p.category, company:p.company||undefined,
          amountMinor:toMinor(p.amountRupees), currency:cur2,
          dueDate:p.dueDate||undefined, story:p.story, details:p.details||undefined,
          charity:!!p.charity, charityDesc:p.charityDesc||undefined,
          city:p.city, country:S.user.country, anonymous:!!p.anonymous,
          photoUrl:p.photoUrl||undefined, privateProofUrl:p.privateProofUrl||undefined, supportPhotoUrl:p.supportUrl||undefined,
          payDirect:!!p.payDirect, billerName:p.billerName||undefined, billerRef:p.billerRef||undefined, billerDestination:p.billerDest||undefined,
          payoutMethods:p.payouts.map(function(po){ return {method:po.method, holderName:po.holder||undefined, account:po.account||undefined, bankName:po.bank||undefined, ifsc:po.ifsc||undefined, branch:po.branch||undefined, qrUrl:po.qrUrl||undefined}; }),
          submit:true
        };
        var res=await api("/bills", {method:"POST", body:payload});
        var bill=res.bill||res;
        p.billId=bill.id; p.requestCode=bill.request_code||bill.requestCode||bill.id;
        // Verification requests from step 5 go to the verification centre
        // (best-effort: a failed request never blocks the submitted post).
        var verifTypes=Object.keys(p.verif).filter(function(k){ return p.verif[k]; });
        for(var vi=0; vi<verifTypes.length; vi++){
          var vt=verifTypes[vi];
          var docUrl=vt==="id"? p.idUrl : (vt==="bill"? p.privateProofUrl : undefined);
          if((vt==="bill"||vt==="id") && !docUrl) continue;
          try{ await api("/verification", {method:"POST", body:{type:vt, billId:bill.id, docUrl:docUrl}}); }catch(e){ /* keep going */ }
        }
        try{ localStorage.removeItem("sp_post_draft"); }catch(e){}
        S.post=blankPost();
        if(op!==NAV) return; // submitted, but the user left; don't clobber the new view
        view('<div class="center-page"><div class="slide-ic">✅</div><h1>'+esc(t("post_submitted"))+'</h1>'
          +'<div class="card" style="width:100%;max-width:420px"><div class="kv"><span>'+esc(t("request_code"))+'</span><b>'+esc(p.requestCode)+'</b></div><div class="kv"><span>'+esc(t("bill_status_label"))+'</span><b>'+esc(t("pending_review"))+'</b></div></div>'
          +'<p>'+esc(t("what_next"))+'</p><a class="btn" style="max-width:360px" href="#/mybills">'+esc(t("see_mybills"))+'</a></div>');
      }catch(e){
        if(op!==NAV) return;
        btn.disabled=false; btn.textContent=t("submit_approval");
        var es=$("#e-submit"); if(es) es.textContent=e.message||t("err_generic");
      }
    });
  }
}

/* ---------- leaders ---------- */
function renderLeaders(){
  view('<h1>'+esc(t("leaders_title"))+'</h1><p class="small">'+esc(t("leaders_scope_note"))+'</p>'
    +'<div class="tabs" id="ld-tabs">'
    +[["top_supporters",t("top_supporters")],["most_received",t("most_received")],["top_bills",t("top_bills")],["fully_paid",t("fully_paid")],["brands",t("leaders_brands")]].map(function(x){ return '<button class="tab-btn'+(S.leadersTab===x[0]?" on":"")+'" data-t="'+x[0]+'">'+esc(x[1])+'</button>'; }).join("")
    +'</div>'
    +'<div style="display:flex;gap:8px;margin-bottom:10px"><select id="ld-period" aria-label="'+esc(t("posted"))+'" style="flex:1"><option value="7d" '+(S.leadersPeriod==="7d"?"selected":"")+'>'+esc(t("last_7"))+'</option><option value="30d" '+(S.leadersPeriod==="30d"?"selected":"")+'>'+esc(t("last_30"))+'</option><option value="all" '+(S.leadersPeriod==="all"?"selected":"")+'>'+esc(t("all_time"))+'</option></select>'
    +'<select id="ld-scope" aria-label="'+esc(t("filter_country"))+'" style="flex:1"><option value="all" '+(S.leadersScope==="all"?"selected":"")+'>'+esc(t("scope_all"))+'</option><option value="NP" '+(S.leadersScope==="NP"?"selected":"")+'>🇳🇵 '+esc(t("nepal"))+'</option><option value="IN" '+(S.leadersScope==="IN"?"selected":"")+'>🇮🇳 '+esc(t("india"))+'</option></select></div>'
    +'<div id="ld-body">'+skeleton(2)+'</div>');
  $all("#ld-tabs .tab-btn").forEach(function(b){ b.onclick=function(){ S.leadersTab=b.getAttribute("data-t"); renderLeaders(); }; });
  $("#ld-period").onchange=function(){ S.leadersPeriod=$("#ld-period").value; load(); };
  $("#ld-scope").onchange=function(){ S.leadersScope=$("#ld-scope").value; load(); };
  load();
  async function load(){
    var body=$("#ld-body"); if(!body) return;
    body.innerHTML=skeleton(2);
    try{
      var q=new URLSearchParams({tab:S.leadersTab, period:S.leadersPeriod, scope:S.leadersScope});
      var d=await api("/leaders?"+q.toString());
      // Brands tab returns two lists (mostResponded / mostAsked), not leaders.
      if(S.leadersTab==="brands"){
        var resp=pickList(d,["mostResponded"]), asked=pickList(d,["mostAsked"]);
        if(!resp.length && !asked.length){ body.innerHTML=emptyState("🏆", t("empty_leaders"), t("leaders_scope_note")); return; }
        var h2="";
        if(resp.length) h2+='<h2>'+esc(t("leaders_brands"))+'</h2>'+resp.map(function(r){ return '<div class="card leader-row"><span class="rank">'+esc(r.rank||"")+'</span><div class="grow" style="flex:1"><strong>'+esc(r.name||"")+'</strong><div class="small">'+esc(r.responses||0)+' '+esc(t("leaders_helped"))+'</div></div></div>'; }).join("");
        if(asked.length) h2+='<h3 style="margin-top:12px">'+esc(t("brands_title"))+'</h3>'+asked.map(function(r){ return '<div class="card leader-row"><span class="rank">'+esc(r.rank||"")+'</span><div class="grow" style="flex:1"><strong>'+esc(r.name||"")+'</strong><div class="small">'+esc(r.asks||0)+' '+esc(t("leaders_helped"))+'</div></div></div>'; }).join("");
        body.innerHTML=h2;
        return;
      }
      var rows=pickList(d,["leaders","entries","rows"]);
      if(!rows.length){ body.innerHTML=emptyState("🏆", t("empty_leaders"), t("leaders_scope_note")); return; }
      var top=rows.slice(0,3), rest=rows.slice(3);
      function amtOf(r){
        var minor=r.totalMinor!=null?r.totalMinor:r.total_minor;
        return minor!=null?money(minor, r.currency||"NPR"):"";
      }
      function helpedOf(r){
        if(r.billsHelped!=null) return r.billsHelped;
        if(r.billsPaid!=null) return r.billsPaid;
        if(r.supporters!=null) return r.supporters;
        if(r.gifts!=null) return r.gifts;
        return r.helped;
      }
      function pod(r, rank){
        var nm=r.anonymous? t("anonymous") : (r.display_name||r.displayName||r.name||r.title||"");
        var amt=amtOf(r);
        var helped=helpedOf(r);
        return '<div class="pod card '+(rank===1?"first":rank===2?"second":"third")+'"><div class="rank">'+(rank===1?"🥇":rank===2?"🥈":"🥉")+'</div><div class="avatar" style="margin:6px auto">'+esc(initials(nm))+'</div><strong>'+esc(nm)+'</strong><div class="small">'+esc(amt)+'</div><div class="small muted">'+esc(helped!=null? helped+" "+t("leaders_helped") : "")+'</div></div>';
      }
      var h='<div class="podium">'+(top[1]?pod(top[1],2):"")+(top[0]?pod(top[0],1):"")+(top[2]?pod(top[2],3):"")+'</div>';
      h+=rest.map(function(r,i){
        var nm=r.anonymous? t("anonymous") : (r.display_name||r.displayName||r.name||r.title||"");
        var amt=amtOf(r);
        var helped=helpedOf(r);
        var link=!r.anonymous&&r.username? 'href="#/profile/'+encodeURIComponent(r.username)+'"' : "";
        var tag=link?"a":"div";
        return '<'+tag+' class="card leader-row" '+link+'><span class="rank">'+(i+4)+'</span><div class="avatar">'+esc(initials(nm))+'</div><div class="grow" style="flex:1;min-width:0"><strong>'+esc(nm)+'</strong><div class="small">'+flag(r.country)+' '+esc(r.city||"")+(helped!=null?" · "+helped+" "+t("leaders_helped"):"")+'</div></div><strong class="money">'+esc(amt)+'</strong></'+tag+'>';
      }).join("");
      body.innerHTML=h;
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}

/* ---------- brands ---------- */
function renderBrands(){
  view('<h1>'+esc(t("brands_title"))+'</h1>'
    +'<div class="btn-row" style="margin-bottom:12px"><a class="btn" href="#/brand-new">＋ '+esc(t("brand_new"))+'</a><a class="btn secondary" href="#/auctions">🔨 '+esc(t("auctions"))+'</a></div>'
    +'<label class="sr-only" for="br-search">'+esc(t("search_brands"))+'</label><input id="br-search" placeholder="'+esc(t("search_brands"))+'" style="margin-bottom:10px">'
    +'<div id="br-body">'+skeleton(2)+'</div>');
  var timer=null;
  $("#br-search").addEventListener("input", function(){ clearTimeout(timer); timer=setTimeout(load, 300); });
  load();
  async function load(){
    var body=$("#br-body"); if(!body) return;
    try{
      var q=new URLSearchParams(); var s=$("#br-search").value.trim(); if(s) q.set("brand", s);
      var d=await api("/brands"+(q.toString()?"?"+q.toString():""));
      var list=pickList(d,["brands"]);
      if(!list.length){ body.innerHTML=emptyState("🏷️", t("empty_brands"), "", '<a class="btn small" href="#/brand-new">'+esc(t("create_first_brand"))+'</a>'); return; }
      body.innerHTML=list.map(function(b){
        return '<a class="card row-card" href="#/brand/'+encodeURIComponent(b.id)+'"><div class="avatar">🏷️</div><div class="grow"><div class="t">'+esc(b.display_name||b.displayName||b.name||"")+'</div><div class="s">'+flag(b.country)+' '+esc(b.city||"")+' · '+esc((b.story||"").slice(0,80))+'</div></div><span>›</span></a>';
      }).join("");
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}
function renderBrand(id){
  var tok=view(skeleton(2));
  api("/brands/"+encodeURIComponent(id)).then(function(d){
    if(tok!==NAV) return;
    var b=d.brand||d;
    view('<a href="#/brands" class="small">← '+esc(t("back"))+'</a><div class="card" style="margin-top:8px">'
      +'<h1>'+esc(b.display_name||b.displayName||b.name||"")+'</h1>'
      +'<p class="small">'+flag(b.country)+' '+esc(b.city||"")+' · '+esc(timeAgo(b.created_at||b.createdAt))+'</p>'
      +'<p>'+esc(b.story||"")+'</p>'
      +(b.content_no_fee?'<p><span class="chip good">'+esc(t("content_ok"))+'</span></p>':"")
      +'<p class="small muted">'+esc(t("brand_ask_footer"))+'</p>'
      +'<div class="btn-row"><button class="btn" id="br-connect">'+esc(t("connect"))+' →</button></div>'
      +'<div class="btn-row"><button class="btn secondary small" id="br-share">🔗 '+esc(t("share"))+'</button><button class="btn secondary small" id="br-report">🚩 '+esc(t("report"))+'</button></div></div>');
    $("#br-share").onclick=function(){ copyText(location.origin+location.pathname+"#/brand/"+b.id, t("copied_link")); };
    $("#br-report").onclick=function(){ openReportSheet("brand", b.id); };
    $("#br-connect").onclick=function(){ openBrandConnect(b); };
  }).catch(function(e){ if(tok!==NAV) return; view(emptyState("🏷️", t("brand_not_found"), e.message||"", "", "h1")); });
}
function openBrandConnect(brand){
  if(!needUser()) return;
  var pkgsRaw=(S.config&&S.config.brandPackages)||[];
  var curPkg=S.user&&countryCode(S.user.country)==="IN"?"INR":"NPR";
  var pkgs=pkgsRaw.length?pkgsRaw.map(function(p){ return {id:p.id||p.name, label:p.name||p.label||p.id, priceMinor:curPkg==="INR"?(p.priceINRMinor!=null?p.priceINRMinor:p.priceMinor||0):(p.priceNPRMinor!=null?p.priceNPRMinor:p.priceMinor||0), currency:curPkg}; })
    :[{id:"free",label:t("plan_free"),priceMinor:0,currency:"NPR"},{id:"plus",label:t("plan_plus"),priceMinor:99900,currency:"NPR"},{id:"campaign",label:t("plan_campaign"),priceMinor:499900,currency:"NPR"}];
  openSheet('<h2>'+esc(t("brand_connect_title"))+'</h2>'+demoHtml()
    +'<p class="small">'+esc(t("brand_connect_body"))+'</p>'
    +'<label for="bc-brand">'+esc(t("brand_name"))+'</label><input id="bc-brand">'
    +'<label for="bc-name">'+esc(t("display_name"))+'</label><input id="bc-name" autocomplete="name">'
    +'<label for="bc-phone">'+esc(t("contact_phone"))+'</label><input id="bc-phone" type="tel" inputmode="tel" autocomplete="tel">'
    +'<label for="bc-note">'+esc(t("brand_story_label"))+' / '+esc(t("details"))+'</label><textarea id="bc-note" maxlength="500"></textarea>'
    +'<label>'+esc(t("brand_connect_price"))+'</label><div class="seg" id="bc-plans">'+pkgs.map(function(p,i){ return '<button type="button" data-p="'+esc(p.id||p.name||("p"+i))+'" class="'+(i===0?"on":"")+'">'+esc(p.label||p.name||"")+(p.priceMinor?' — '+money(p.priceMinor,p.currency||"NPR"):"")+'</button>'; }).join("")+'</div>'
    +'<div id="bc-email-wrap" hidden><label for="bc-email">'+esc(t("company_email"))+'</label><input id="bc-email" type="email" autocomplete="email" placeholder="name@company.com"><p class="small">'+esc(t("brand_plan_note"))+'</p></div>'
    +'<label class="check-row"><input type="checkbox" id="bc-agree"> '+esc(t("agree_first_connect"))+'</label>'
    +'<p class="small">'+esc(t("brand_connect_refund"))+'</p>'
    +'<div class="field-err" id="bc-err" role="alert"></div>'
    +'<div class="btn-row"><button class="btn secondary" id="bc-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="bc-send">'+esc(t("connect"))+'</button></div>');
  var plan=pkgs[0].id||pkgs[0].name||"p0";
  $all("#bc-plans button").forEach(function(b){ b.onclick=function(){ $all("#bc-plans button").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on"); plan=b.getAttribute("data-p"); $("#bc-email-wrap").hidden=(plan===pkgs[0].id||plan===pkgs[0].name||plan==="p0"); }; });
  $("#bc-cancel").onclick=closeSheets;
  $("#bc-send").onclick=async function(){
    var brandName=$("#bc-brand").value.trim(), name=$("#bc-name").value.trim(), phone=$("#bc-phone").value.trim();
    $("#bc-err").textContent="";
    if(!brandName||!name||!phone){ $("#bc-err").textContent=t("err_connect_fields"); return; }
    if(!$("#bc-agree").checked){ $("#bc-err").textContent=t("agree_first_connect"); return; }
    var email=$("#bc-email")?$("#bc-email").value.trim():"";
    var needsEmail=!$("#bc-email-wrap").hidden;
    if(needsEmail){
      var personal=/@(gmail|hotmail|outlook|icloud|yahoo)\./i.test(email);
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)||personal){ $("#bc-err").textContent=t("err_company_email"); return; }
    }
    var btn=$("#bc-send"); btn.disabled=true; btn.textContent=t("loading");
    try{
      await api("/brands/"+encodeURIComponent(brand.id)+"/connect", {method:"POST", body:{brandName:brandName, contactName:name, phone:phone, note:$("#bc-note").value.trim(), plan:plan, workEmail:email||undefined}});
      closeSheets(); toast(t("brand_connected"));
    }catch(e){ btn.disabled=false; btn.textContent=t("connect"); toast(e.message||t("err_generic"), true); }
  };
}
function renderBrandNew(){
  if(!S.user){ view(emptyState("🏷️", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  view('<h1>'+esc(t("brand_new"))+'</h1><p class="small">'+esc(t("brand_ask_footer"))+'</p><p class="small">'+esc(t("required_note"))+'</p>'
    +'<form id="bn-form" class="card"><label for="bn-brand">'+esc(t("brand_name"))+' '+reqStar()+'</label><input id="bn-brand" maxlength="100" aria-required="true" aria-describedby="e-bn-brand"><div class="field-err" id="e-bn-brand" role="alert"></div>'
    +'<label for="bn-display">'+esc(t("display_name"))+' '+esc(t("q_about_opt"))+'</label><input id="bn-display" maxlength="100">'
    +'<label for="bn-story">'+esc(t("brand_story"))+' '+reqStar()+'</label><textarea id="bn-story" maxlength="1500" placeholder="'+esc(t("brand_story_hint"))+'" aria-required="true" aria-describedby="e-bn-story"></textarea><div class="field-err" id="e-bn-story" role="alert"></div>'
    +'<label>'+esc(t("country"))+'</label><div class="seg" id="bn-country"><button type="button" data-c="NP" class="'+(countryCode(S.user.country)==="NP"?"on":"")+'">🇳🇵 '+esc(t("nepal"))+'</button><button type="button" data-c="IN" class="'+(countryCode(S.user.country)==="IN"?"on":"")+'">🇮🇳 '+esc(t("india"))+'</button></div>'
    +'<label for="bn-city">'+esc(t("city"))+' '+esc(t("q_about_opt"))+'</label><input id="bn-city" value="'+esc(S.user.city||"")+'" autocomplete="address-level2">'
    +'<label for="bn-phone">'+esc(t("contact_phone"))+' '+reqStar()+'</label><input id="bn-phone" type="tel" inputmode="tel" autocomplete="tel" aria-required="true" aria-describedby="e-bn-phone"><div class="field-err" id="e-bn-phone" role="alert"></div>'
    +'<label for="bn-file">'+esc(t("visual_plan"))+'</label><input type="file" id="bn-file" accept="image/jpeg,image/png,image/webp">'
    +'<label class="check-row"><input type="checkbox" id="bn-content"> '+esc(t("content_no_fee"))+'</label>'
    +'<p class="small">⚠️ '+esc(t("no_contact_in_text"))+'</p>'
    +'<button class="btn" type="submit" id="bn-submit">'+esc(t("submit"))+'</button></form>');
  var cc=countryCode(S.user.country);
  $all("#bn-country button").forEach(function(b){ b.onclick=function(){ cc=b.getAttribute("data-c"); $all("#bn-country button").forEach(function(x){ x.classList.toggle("on", x===b); }); }; });
  $("#bn-form").addEventListener("submit", async function(e){
    e.preventDefault();
    var brand=$("#bn-brand").value.trim(), story=$("#bn-story").value.trim(), phone=$("#bn-phone").value.trim();
    var ok=true;
    setFieldErr("bn-brand","e-bn-brand",""); setFieldErr("bn-story","e-bn-story",""); setFieldErr("bn-phone","e-bn-phone","");
    if(!brand){ setFieldErr("bn-brand","e-bn-brand",t("err_brand_name")); ok=false; }
    if(!story){ setFieldErr("bn-story","e-bn-story",t("err_brand_story")); ok=false; }
    if(story && /(@|https?:\/\/|www\.|\b\d{7,}\b)/.test(story)){ setFieldErr("bn-story","e-bn-story",t("no_contact_in_text")); ok=false; }
    if(!phone){ setFieldErr("bn-phone","e-bn-phone",t("err_phone")); ok=false; }
    if(!ok) return;
    var btn=$("#bn-submit"); btn.disabled=true; btn.textContent=t("loading");
    var op=NAV;
    try{
      var visualUrl=null;
      var f=$("#bn-file").files[0];
      if(f){ var up=await uploadFile(f,"support"); visualUrl=up.url||up.fileUrl||up.path; }
      await api("/brands", {method:"POST", body:{name:brand, displayName:$("#bn-display").value.trim()||undefined, story:story, country:cc, city:$("#bn-city").value.trim()||undefined, contactPhone:phone, contentNoFee:!!$("#bn-content").checked, visualUrl:visualUrl||undefined}});
      if(op!==NAV) return;
      toast(t("brand_ask_sent")); go("#/brands");
    }catch(err){ if(op!==NAV) return; btn.disabled=false; btn.textContent=t("submit"); toast(err.message||t("err_generic"), true); }
  });
}

/* ---------- auctions ---------- */
function renderAuctions(){
  view('<h1>'+esc(t("auctions"))+'</h1><p class="small">'+esc(t("auction_disabled_note"))+'</p>'
    +'<div class="btn-row" style="margin-bottom:12px"><button class="btn" id="au-new">＋ '+esc(t("create_auction"))+'</button></div>'
    +'<div id="au-body">'+skeleton(2)+'</div>');
  $("#au-new").onclick=function(){ if(needUser()) openAuctionCreate(); };
  load();
  async function load(){
    var body=$("#au-body"); if(!body) return;
    try{
      var d=await api("/auctions");
      var list=pickList(d,["auctions"]);
      if(!list.length){ body.innerHTML=emptyState("🔨", t("empty_auctions"), "", '<button class="btn small" id="au-empty-new">'+esc(t("create_first_auction"))+'</button>'); var b=$("#au-empty-new"); if(b) b.onclick=function(){ if(needUser()) openAuctionCreate(); }; return; }
      body.innerHTML=list.map(function(a){
        var cur=a.currency||"NPR";
        return '<a class="card row-card" href="#/auction/'+encodeURIComponent(a.id)+'"><div class="avatar">🔨</div><div class="grow"><div class="t">'+esc(a.title||"")+'</div><div class="s">'+esc(t("current_bid"))+': '+esc(money(a.current_bid_minor||a.currentBidMinor||a.start_bid_minor||a.startBidMinor||0, cur))+' · '+esc(t("ends"))+' '+esc((a.endsAt||a.ends_at)?fmtDate(a.endsAt||a.ends_at):"—")+'</div></div><span>›</span></a>';
      }).join("");
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}
function openAuctionCreate(){
  openSheet('<h2>'+esc(t("auction_create"))+'</h2>'+demoHtml()
    +'<label for="ac-title">'+esc(t("auction_title"))+'</label><input id="ac-title" maxlength="100">'
    +'<label for="ac-desc">'+esc(t("auction_desc"))+'</label><textarea id="ac-desc" maxlength="1500"></textarea>'
    +'<label for="ac-cat">'+esc(t("category"))+'</label><select id="ac-cat">'+I.categories().map(function(c){ return '<option>'+esc(c)+'</option>'; }).join("")+'</select>'
    +'<label for="ac-bid">'+esc(t("start_bid"))+' ('+(S.user&&countryCode(S.user.country)==="IN"?"₹":"रू")+')</label><input id="ac-bid" type="number" min="0" step="1">'
    +'<label for="ac-ends">'+esc(t("auction_ends"))+'</label><input id="ac-ends" type="datetime-local">'
    +'<label for="ac-file">'+esc(t("upload"))+'</label><input type="file" id="ac-file" accept="image/jpeg,image/png,image/webp">'
    +'<div class="field-err" id="ac-err" role="alert"></div>'
    +'<div class="btn-row"><button class="btn secondary" id="ac-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="ac-send">'+esc(t("submit"))+'</button></div>');
  $("#ac-cancel").onclick=closeSheets;
  $("#ac-send").onclick=async function(){
    var title=$("#ac-title").value.trim(), bid=toMinor($("#ac-bid").value), ends=$("#ac-ends").value;
    if(!title||bid<=0||!ends){ $("#ac-err").textContent=t("err_auction_fields"); return; }
    var btn=$("#ac-send"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var photoUrl=null; var f=$("#ac-file").files[0];
      if(f){ var up=await uploadFile(f,"support"); photoUrl=up.url||up.fileUrl||up.path; }
      await api("/auctions", {method:"POST", body:{title:title, description:$("#ac-desc").value.trim(), category:$("#ac-cat").value, country:countryCode(S.user.country), currency:curOf(S.user.country), startBidMinor:bid, endsAt:new Date(ends).toISOString(), photoUrl:photoUrl||undefined}});
      closeSheets(); toast(t("auction_submitted")); route();
    }catch(e){ btn.disabled=false; btn.textContent=t("submit"); toast(e.message||t("err_generic"), true); }
  };
}
function renderAuction(id){
  var tok=view(skeleton(2));
  api("/auctions/"+encodeURIComponent(id)).then(function(d){
    if(tok!==NAV) return;
    var a=d.auction||d;
    var cur=a.currency||"NPR";
    var bids=pickList(a,["bids"])||pickList(d,["bids"]);
    var high=a.current_bid_minor||a.currentBidMinor||a.start_bid_minor||a.startBidMinor||0;
    var _ends=a.endsAt||a.ends_at; var ended=_ends? new Date(_ends).getTime()<Date.now() : false;
    var isOwner=S.user && String(a.user_id||a.userId)===String(S.user.id);
    view('<a href="#/auctions" class="small">← '+esc(t("back"))+'</a><div class="card" style="margin-top:8px">'
      +((a.photoUrl||a.photo_url)?'<img class="bill-photo" src="'+esc(a.photoUrl||a.photo_url)+'" alt="'+esc(t("auction_photo_alt"))+'" loading="lazy">':"")
      +'<h1>'+esc(a.title||"")+'</h1><p>'+esc(a.description||"")+'</p>'
      +'<div class="kv"><span>'+esc(t("current_bid"))+'</span><b>'+esc(money(high,cur))+'</b></div>'
      +'<div class="kv"><span>'+esc(t("start_bid"))+'</span><b>'+esc(money(a.start_bid_minor||a.startBidMinor||0,cur))+'</b></div>'
      +'<div class="kv"><span>'+esc(t("ends"))+'</span><b>'+esc(_ends?new Date(_ends).toLocaleString():"—")+' '+(ended?esc(t("ended")):"")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("seller"))+'</span><b>'+esc(((a.seller||{}).displayName||(a.seller||{}).display_name||(a.user||{}).display_name||a.seller_name||""))+'</b></div>'
      +demoHtml()+'<p class="small">'+esc(t("auction_disabled_note"))+'</p>'
      +(ended?'<p><strong>'+esc(t("auction_ended"))+'</strong></p>':(isOwner?'<p class="small">'+esc(t("bid_self"))+'</p>':'<label for="bid-amt">'+esc(t("your_bid"))+' ('+(cur==="INR"?"₹":"रू")+')</label><input id="bid-amt" type="number" min="0" step="1" aria-describedby="bid-err"><div class="field-err" id="bid-err" role="alert"></div><button class="btn" id="bid-btn">'+esc(t("place_bid"))+'</button><p class="small">'+esc(t("outbid_note"))+'</p>'))
      +'<div class="btn-row"><button class="btn secondary small" id="au-share">🔗 '+esc(t("share"))+'</button><button class="btn secondary small" id="au-report">🚩 '+esc(t("report"))+'</button></div></div>'
      +'<div class="card" style="margin-top:12px"><h2>'+esc(t("bid_history"))+'</h2>'
      +(bids.length? bids.map(function(bd){ return '<div class="kv"><span>'+esc(bd.anonymous?t("anonymous"):(bd.bidderName||bd.bidder_name||bd.display_name||bd.bidderUsername||bd.username||t("anonymous")))+'</span><b>'+esc(money(bd.amount_minor||bd.amountMinor||0,cur))+' · '+esc(timeAgo(bd.createdAt||bd.created_at))+'</b></div>'; }).join("") : '<p>'+esc(t("no_bids"))+'</p>')+'</div>');
    $("#au-share").onclick=function(){ copyText(location.origin+location.pathname+"#/auction/"+a.id, t("copied_link")); };
    $("#au-report").onclick=function(){ openReportSheet("auction", a.id); };
    var bb=$("#bid-btn");
    if(bb) bb.onclick=async function(){
      if(!needUser()) return;
      var amt=toMinor($("#bid-amt").value);
      if(amt<=high){ $("#bid-err").textContent=t("bid_min"); return; }
      bb.disabled=true; bb.textContent=t("loading");
      try{ await api("/auctions/"+encodeURIComponent(a.id)+"/bid", {method:"POST", body:{amountMinor:amt}}); toast(t("bid_placed")); route(); }
      catch(e){ bb.disabled=false; bb.textContent=t("place_bid"); toast(e.message||t("err_generic"), true); }
    };
  }).catch(function(e){ if(tok!==NAV) return; view(emptyState("🔨", t("auction_not_found"), e.message||"", "", "h1")); });
}

/* ---------- my bills ---------- */
function renderMyBills(){
  if(!S.user){ view(emptyState("📁", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  var tabs=[["active",t("active")],["pending",t("pending_review")],["approved",t("approved")],["rejected",t("rejected")],["completed",t("completed")],["given",t("help_given")],["received",t("help_received")]];
  view('<h1>'+esc(t("my_bills"))+'</h1><p class="small">'+esc(t("mybills_tabs_note"))+'</p>'
    +'<div class="tabs">'+tabs.map(function(x){ return '<button class="tab-btn'+(S.mybillsTab===x[0]?" on":"")+'" data-t="'+x[0]+'">'+esc(x[1])+'</button>'; }).join("")+'</div>'
    +'<div id="mb-body">'+skeleton(2)+'</div>');
  $all(".tab-btn").forEach(function(b){ b.onclick=function(){ S.mybillsTab=b.getAttribute("data-t"); renderMyBills(); }; });
  load();
  async function load(){
    var body=$("#mb-body"); if(!body) return;
    if(S.mybillsTab==="given"||S.mybillsTab==="received"){
      try{
        var d=await api("/gifts/mine?type="+S.mybillsTab);
        var gifts=pickList(d,["gifts"]);
        if(!gifts.length){ body.innerHTML=emptyState("💙", t("empty_gifts"), S.mybillsTab==="given"?t("no_gifts_given"):t("no_gifts_received"), S.mybillsTab==="given"?'<a class="btn small" href="#/swipe">'+esc(t("go_swipe"))+'</a>':""); return; }
        body.innerHTML=gifts.map(function(g){ return giftRowHtml(g); }).join("");
        bindGiftRows(body);
      }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
      return;
    }
    try{
      var statusMap={active:"", pending:"pending_review", approved:"approved", rejected:"rejected", completed:"completed"};
      var q=statusMap[S.mybillsTab]? "?status="+statusMap[S.mybillsTab] : "";
      var d2=await api("/bills/mine"+q);
      var bills=pickList(d2,["bills"]);
      if(S.mybillsTab==="active") bills=bills.filter(function(b){ return ["draft","pending_review","approved","changes_requested","paused","under_investigation"].indexOf(b.status)>=0; });
      if(!bills.length){ body.innerHTML=emptyState("📁", t("empty_mybills"), "", '<a class="btn small" href="#/post">'+esc(t("post_first_bill"))+'</a>'); return; }
      body.innerHTML=bills.map(function(b){
        var cur=b.currency||"NPR";
        return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(b.title||"")+'</strong>'+statusChip(b.status)+'</div>'
          +'<p class="small">'+esc(b.request_code||b.requestCode||"")+' · '+esc(b.category||"")+' · '+esc(money(b.amount_minor||b.amountMinor||0,cur))+'</p>'
          + progressHtml(b)
          +'<p class="small">'+esc(b.supporterCount!=null?b.supporterCount:(b.supporter_count||0))+' '+esc(t("supporters"))+' · '+esc(b.views||0)+' '+esc(t("views"))+((b.dueDate||b.due_date)?" · "+esc(t("due_date"))+" "+esc(fmtDate(b.dueDate||b.due_date)):"")+'</p>'
          +((b.rejectionReason||b.rejection_reason)?'<p class="small" style="color:var(--bad)">'+esc(b.rejectionReason||b.rejection_reason)+'</p>':"")
          +((b.changesNote||b.changes_note)?'<p class="small" style="color:var(--warn)">'+esc(b.changesNote||b.changes_note)+'</p>':"")
          +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
          +'<a class="btn secondary small" href="#/bill/'+encodeURIComponent(b.id)+'">'+esc(t("view_bill"))+'</a>'
          +'<button class="btn secondary small" data-act="edit" data-id="'+esc(b.id)+'">'+esc(t("edit"))+'</button>'
          +'<button class="btn secondary small" data-act="payout" data-id="'+esc(b.id)+'">'+esc(t("change_payout"))+'</button>'
          +'<button class="btn secondary small" data-act="docs" data-id="'+esc(b.id)+'">'+esc(t("upload_docs"))+'</button>'
          +(b.status==="approved"?'<button class="btn secondary small" data-act="share" data-id="'+esc(b.id)+'">'+esc(t("share"))+'</button>':"")
          +(b.status!=="completed"&&b.status!=="removed"?'<button class="btn secondary small" data-act="complete" data-id="'+esc(b.id)+'">'+esc(t("mark_completed"))+'</button>':"")
          +'<button class="btn secondary small" data-act="remove" data-id="'+esc(b.id)+'">'+esc(t("remove"))+'</button>'
          +'</div></div>';
      }).join("");
      $all("[data-act]", body).forEach(function(btn){
        btn.onclick=function(){
          var act=btn.getAttribute("data-act"), id=btn.getAttribute("data-id");
          var bill=bills.find(function(x){ return String(x.id)===String(id); });
          if(act==="share") copyText(location.origin+location.pathname+"#/bill/"+id, t("copied_link"));
          if(act==="edit") openBillEdit(bill);
          if(act==="payout") openPayoutChange(bill);
          if(act==="docs") openDocsUpload(bill);
          if(act==="complete") confirmDialog(t("complete_confirm_title"), t("complete_confirm_body"), t("mark_completed"), async function(){ try{ await api("/bills/"+encodeURIComponent(id)+"/complete", {method:"POST"}); toast(t("complete_bill")); load(); }catch(e){ toast(e.message||t("err_generic"), true); } });
          if(act==="remove") confirmDialog(t("remove_confirm_title"), t("remove_confirm_body"), t("remove"), async function(){ try{ await api("/bills/"+encodeURIComponent(id)+"/remove", {method:"POST"}); toast(t("bill_removed")); load(); }catch(e){ toast(e.message||t("err_generic"), true); } }, true);
        };
      });
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}
function giftStatusLabel(s){
  var map={initiated:t("gift_status_initiated"),details_shown:t("gift_status_details"),donor_reported_sent:t("gift_status_reported"),verification_pending:t("gift_status_pending"),confirmed:t("gift_status_confirmed"),failed:t("gift_status_failed"),disputed:t("gift_status_disputed"),reversed:t("gift_status_reversed")};
  return map[s]||s||"";
}
function giftRowHtml(g){
  var cur=g.currency||"NPR";
  var other=g.bill_title||g.billTitle||g.other_name||"";
  return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(money(g.amount_minor||g.amountMinor||0,cur))+'</strong><span class="chip">'+esc(giftStatusLabel(g.status))+'</span></div>'
    +'<p class="small">'+esc(other)+' · '+esc(timeAgo(g.created_at||g.createdAt))+(g.reference?" · "+esc(t("reference_label"))+": "+esc(g.reference):"")+'</p>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap">'
    +((g.billId||g.bill_id)?'<a class="btn secondary small" href="#/bill/'+encodeURIComponent(g.billId||g.bill_id)+'">'+esc(t("view_bill"))+'</a>':"")
    +(g.status==="donor_reported_sent"&&S.mybillsTab==="received"?'<button class="btn small" data-gift="confirm" data-id="'+esc(g.id)+'">'+esc(t("confirm_yes"))+'</button><button class="btn secondary small" data-gift="notreceived" data-id="'+esc(g.id)+'">'+esc(t("not_received"))+'</button>':"")
    +(g.status!=="confirmed"&&g.status!=="disputed"?'<button class="btn secondary small" data-gift="dispute" data-id="'+esc(g.id)+'">'+esc(t("dispute"))+'</button>':"")
    +'</div></div>';
}
function bindGiftRows(root){
  $all("[data-gift]", root).forEach(function(btn){
    btn.onclick=async function(){
      var act=btn.getAttribute("data-gift"), id=btn.getAttribute("data-id");
      if(act!=="dispute") btn.disabled=true;
      try{
        if(act==="confirm"){ await api("/gifts/"+encodeURIComponent(id)+"/confirm", {method:"POST"}); toast(t("gift_confirmed_msg")); }
        if(act==="notreceived"){ await api("/gifts/"+encodeURIComponent(id)+"/not-received", {method:"POST"}); toast(t("not_received_noted")); }
        if(act==="dispute"){
          openSheet('<h2>'+esc(t("dispute"))+'</h2><label for="dp-note">'+esc(t("dispute_note_label"))+'</label><textarea id="dp-note" placeholder="'+esc(t("dispute_note_ph"))+'"></textarea><button class="btn" id="dp-send">'+esc(t("send_dispute"))+'</button>');
          $("#dp-send").onclick=async function(){ var b2=$("#dp-send"); b2.disabled=true; b2.textContent=t("loading"); try{ await api("/gifts/"+encodeURIComponent(id)+"/dispute", {method:"POST", body:{note:$("#dp-note").value.trim()}}); closeSheets(); toast(t("dispute_opened")); route(); }catch(e){ b2.disabled=false; b2.textContent=t("send_dispute"); toast(e.message||t("err_generic"), true); } };
          return;
        }
        route();
      }catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
    };
  });
}
function openBillEdit(bill){
  openSheet('<h2>'+esc(t("edit_bill"))+'</h2><p class="small">⚠️ '+esc(t("material_edit_warn"))+'</p>'
    +'<label for="be-title">'+esc(t("title_label"))+'</label><input id="be-title" maxlength="80" value="'+esc(bill.title||"")+'">'
    +'<label for="be-story">'+esc(t("short_story"))+'</label><textarea id="be-story" maxlength="280">'+esc(bill.story||"")+'</textarea>'
    +'<label for="be-details">'+esc(t("long_story"))+'</label><textarea id="be-details" maxlength="1500">'+esc(bill.details||"")+'</textarea>'
    +'<label for="be-amount">'+esc(t("amount_label"))+' ('+(bill.currency==="INR"?"₹":"रू")+')</label><input id="be-amount" type="number" min="0" step="1" value="'+fromMinor(bill.amount_minor||bill.amountMinor||0)+'">'
    +'<div class="btn-row"><button class="btn secondary" id="be-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="be-save">'+esc(t("save"))+'</button></div>');
  $("#be-cancel").onclick=closeSheets;
  $("#be-save").onclick=async function(){
    var btn=$("#be-save"); btn.disabled=true; btn.textContent=t("loading");
    try{
      await api("/bills/"+encodeURIComponent(bill.id), {method:"PATCH", body:{title:$("#be-title").value.trim(), story:$("#be-story").value.trim(), details:$("#be-details").value.trim(), amountMinor:toMinor($("#be-amount").value)}});
      closeSheets(); toast(t("bill_updated")); route();
    }catch(e){ btn.disabled=false; btn.textContent=t("save"); toast(e.message||t("err_generic"), true); }
  };
}
function openPayoutChange(bill){
  var methods=payoutMethodsFor(S.user.country);
  openSheet('<h2>'+esc(t("change_payout"))+'</h2><p class="small">⚠️ '+esc(t("payout_change_warn"))+'</p>'
    +'<label for="pc-method">'+esc(t("payment_methods"))+'</label><select id="pc-method">'+methods.map(function(m){ return '<option value="'+m.id+'">'+esc(m.label)+'</option>'; }).join("")+'</select>'
    +'<div id="pc-fields"></div><div class="field-err" id="pc-err" role="alert"></div>'
    +'<label class="check-row"><input type="checkbox" id="pc-belongs"> '+esc(t("payout_belongs"))+'</label>'
    +'<div class="btn-row"><button class="btn secondary" id="pc-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="pc-save">'+esc(t("save"))+'</button></div>');
  function fields(){
    var m=$("#pc-method").value, h="";
    if(m==="esewa") h='<label for="pc-account">'+esc(t("esewa_no"))+'</label><input id="pc-account" type="tel" inputmode="numeric" autocomplete="tel" maxlength="10">';
    else if(m==="khalti") h='<label for="pc-account">'+esc(t("khalti_no"))+'</label><input id="pc-account" type="tel" inputmode="numeric" autocomplete="tel" maxlength="10">';
    else if(m==="upi") h='<label for="pc-account">'+esc(t("upi_id"))+'</label><input id="pc-account" placeholder="name@okhdfc">';
    else if(m==="payment_link") h='<label for="pc-account">'+esc(t("payment_link"))+'</label><input id="pc-account" placeholder="https://…">';
    else { h='<label for="pc-bank">'+esc(t("bank_name"))+'</label><input id="pc-bank"><label for="pc-account">'+esc(t("account_no"))+'</label><input id="pc-account" inputmode="numeric"><label for="pc-branch">'+esc(t("branch"))+'</label><input id="pc-branch">'; if(m==="bank_in") h+='<label for="pc-ifsc">'+esc(t("ifsc"))+'</label><input id="pc-ifsc" placeholder="SBIN0001234">'; }
    if(m!=="payment_link") h+='<label for="pc-holder">'+esc(t("holder_name"))+'</label><input id="pc-holder" autocomplete="name">';
    $("#pc-fields").innerHTML=h;
  }
  fields();
  $("#pc-method").onchange=fields;
  $("#pc-cancel").onclick=closeSheets;
  $("#pc-save").onclick=async function(){
    var m=$("#pc-method").value;
    var f={account:$("#pc-account")?$("#pc-account").value.trim():"", holder:$("#pc-holder")?$("#pc-holder").value.trim():"", bank:$("#pc-bank")?$("#pc-bank").value.trim():"", ifsc:$("#pc-ifsc")?$("#pc-ifsc").value.trim():"", branch:$("#pc-branch")?$("#pc-branch").value.trim():""};
    var err=validatePayout(m, f);
    if(err){ $("#pc-err").textContent=err; return; }
    if(!$("#pc-belongs").checked){ $("#pc-err").textContent=t("payout_belongs"); return; }
    var btn=$("#pc-save"); btn.disabled=true; btn.textContent=t("loading");
    try{
      await api("/bills/"+encodeURIComponent(bill.id)+"/payout", {method:"POST", body:{payoutMethods:[{method:m, holderName:f.holder, account:f.account, bankName:f.bank||undefined, ifsc:f.ifsc||undefined, branch:f.branch||undefined}]}});
      closeSheets(); toast(t("payout_changed")); route();
    }catch(e){ btn.disabled=false; btn.textContent=t("save"); toast(e.message||t("err_generic"), true); }
  };
}
function openDocsUpload(bill){
  openSheet('<h2>'+esc(t("docs_title"))+'</h2>'
    +'<label for="du-public">'+esc(t("public_photo_label"))+'</label><input type="file" id="du-public" accept="image/jpeg,image/png,image/webp">'
    +'<label for="du-proof">'+esc(t("private_proof_label"))+'</label><input type="file" id="du-proof" accept="image/jpeg,image/png,image/webp,application/pdf">'
    +'<label for="du-support">'+esc(t("support_photo_label"))+'</label><input type="file" id="du-support" accept="image/jpeg,image/png,image/webp">'
    +'<div class="btn-row"><button class="btn secondary" id="du-cancel">'+esc(t("cancel"))+'</button><button class="btn" id="du-save">'+esc(t("upload"))+'</button></div>');
  $("#du-cancel").onclick=closeSheets;
  $("#du-save").onclick=async function(){
    var btn=$("#du-save"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var patch={};
      var pub=$("#du-public").files[0], pr=$("#du-proof").files[0], sup=$("#du-support").files[0];
      if(pub){ var u1=await uploadFile(pub,"public_bill"); patch.photoUrl=u1.url||u1.fileUrl||u1.path; }
      if(pr){ var u2=await uploadFile(pr,"private_proof"); patch.privateProofUrl=u2.url||u2.fileUrl||u2.path; }
      if(sup){ var u3=await uploadFile(sup,"support"); patch.supportPhotoUrl=u3.url||u3.fileUrl||u3.path; }
      if(Object.keys(patch).length) await api("/bills/"+encodeURIComponent(bill.id), {method:"PATCH", body:patch});
      closeSheets(); toast(t("doc_uploaded")); route();
    }catch(e){ btn.disabled=false; btn.textContent=t("upload"); toast(e.message||t("err_generic"), true); }
  };
}

/* ---------- public profile ---------- */
function renderProfile(username){
  var tok=view(skeleton(2));
  api("/profile/"+encodeURIComponent(username)).then(function(d){
    if(tok!==NAV) return;
    var u=d.profile||d.user||d;
    var bills=pickList(d,["bills","liveAsks"])||[];
    var blocked=S.blocked.indexOf(u.id||username)>=0;
    view('<div class="card" style="text-align:center"><div class="avatar" style="width:84px;height:84px;font-size:32px;margin:0 auto">'+(u.photo_url||u.photoUrl?'<img src="'+esc(u.photo_url||u.photoUrl)+'" alt="">':esc(initials(u.display_name||u.displayName)))+'</div>'
      +'<h1 style="margin-top:10px">'+esc(u.display_name||u.displayName||"")+'</h1><p class="small">@'+esc(u.username||username)+' · '+flag(u.country)+' '+esc(u.city||"")+'</p>'
      +'<p>'+esc(u.about||"")+'</p>'
      +'<p class="small">'+esc(t("member_since"))+' '+esc(u.created_at?fmtDate(u.created_at):"")+'</p>'
      +'<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap">'+(u.verifications?badgesHtml({verifications:u.verifications}):"")+'</div>'
      +'<div class="grid2" style="margin-top:12px"><div class="card stat"><div class="n">'+esc(u.live_asks!=null?u.live_asks:bills.length)+'</div><div class="l">'+esc(t("live_asks"))+'</div></div>'
      +'<div class="card stat"><div class="n">'+esc(u.completed_asks||0)+'</div><div class="l">'+esc(t("completed_asks"))+'</div></div></div>'
      +(S.user&&(u.username===S.user.username||u.id===S.user.id)?'<div class="grid2" style="margin-top:10px"><div class="card stat"><div class="n">'+esc(S.saved.length)+'</div><div class="l">'+esc(t("saved_title"))+'</div></div><div class="card stat"><div class="n">'+esc(loadDrafts().length)+'</div><div class="l">'+esc(t("drafts_title"))+'</div></div></div>':"")
      +(u.show_totals===false?'<p class="small">'+esc(t("totals_private"))+'</p>':'<div class="grid2" style="margin-top:10px"><div class="card stat"><div class="n">'+esc(money(u.total_given_minor||0, curOf(u.country)))+'</div><div class="l">'+esc(t("given"))+'</div></div><div class="card stat"><div class="n">'+esc(money(u.total_received_minor||0, curOf(u.country)))+'</div><div class="l">'+esc(t("received_total"))+'</div></div></div>')
      +'<div class="btn-row"><button class="btn secondary small" id="pf-share">🔗 '+esc(t("share_profile"))+'</button><button class="btn secondary small" id="pf-report">🚩 '+esc(t("report_user"))+'</button><button class="btn secondary small" id="pf-block">'+esc(blocked?t("unblock"):t("block_user"))+'</button></div></div>'
      +'<h2>'+esc(t("live_asks"))+'</h2><div id="pf-bills">'
      +(bills.length? bills.map(function(b){ return '<a class="card row-card" href="#/bill/'+encodeURIComponent(b.id)+'"><div class="grow"><div class="t">'+esc(b.title||"")+'</div><div class="s">'+esc(money(b.amount_minor||b.amountMinor||0, b.currency||"NPR"))+' · '+esc(b.category||"")+'</div></div><span>›</span></a>'; }).join("") : '<p>'+esc(t("empty_mybills"))+'</p>')
      +'</div>');
    $("#pf-share").onclick=function(){ copyText(location.origin+location.pathname+"#/profile/"+(u.username||username), t("copy_profile_link")); };
    $("#pf-report").onclick=function(){ openReportSheet("user", u.id||username); };
    $("#pf-block").onclick=function(){
      var key=u.id||username;
      var i=S.blocked.indexOf(key);
      if(i>=0){ S.blocked.splice(i,1); } else { S.blocked.push(key); }
      saveBlocked(); toast(t("blocked")); route();
    };
  }).catch(function(e){ if(tok!==NAV) return; view(emptyState("👤", t("profile_not_found"), e.message||"", "", "h1")); });
}

/* ---------- settings ---------- */
function renderSettings(){
  if(!S.user){ view(emptyState("⚙️", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  var u=S.user;
  var prefs=u.prefs||{};
  var np=prefs.notifyPrefs||{};
  var npPosts=np.posts!==false, npGifts=np.gifts!==false, npBrands=np.brands!==false;
  var showTotals=prefs.showTotals!==false && u.show_totals!==false;
  var anonDefault=prefs.anonDefault===true || u.anon_default===true;
  var themePref="system"; try{ themePref=localStorage.getItem("sp_theme")||"system"; }catch(e){}
  view('<h1>'+esc(t("settings"))+'</h1>'
    +'<div class="card"><h2>'+esc(t("edit_profile"))+'</h2>'
    +'<label for="st-name">'+esc(t("display_name"))+'</label><input id="st-name" maxlength="60" value="'+esc(u.display_name||u.displayName||"")+'" autocomplete="name">'
    +'<label for="st-username">'+esc(t("username"))+'</label><input id="st-username" maxlength="30" value="'+esc(u.username||"")+'" autocomplete="username"><p class="small">'+esc(t("username_rules"))+'</p>'
    +'<label for="st-city">'+esc(t("city"))+'</label><input id="st-city" value="'+esc(u.city||"")+'" autocomplete="address-level2">'
    +'<label for="st-about">'+esc(t("about"))+'</label><textarea id="st-about" maxlength="500">'+esc(u.about||"")+'</textarea>'
    +'<label for="st-photo">'+esc(t("q_photo"))+'</label><input type="file" id="st-photo" accept="image/jpeg,image/png,image/webp"><p class="small">'+esc(t("photo_change_review"))+'</p>'
    +'<label>'+esc(t("country"))+'</label><div class="seg" id="st-country"><button type="button" data-c="NP" class="'+(countryCode(u.country)==="NP"?"on":"")+'">🇳🇵 '+esc(t("nepal"))+'</button><button type="button" data-c="IN" class="'+(countryCode(u.country)==="IN"?"on":"")+'">🇮🇳 '+esc(t("india"))+'</button></div><p class="small">'+esc(t("change_country_note"))+'</p>'
    +'<button class="btn" id="st-save-profile" style="margin-top:12px">'+esc(t("save"))+'</button></div>'
    +'<div class="card" style="margin-top:12px"><h2>'+esc(t("prefs_section"))+'</h2>'
    +'<label>'+esc(t("language"))+'</label><div class="seg" id="st-lang"><button type="button" data-l="en" class="'+(I.getLang()==="en"?"on":"")+'">English</button><button type="button" data-l="ne" class="'+(I.getLang()==="ne"?"on":"")+'">नेपाली</button><button type="button" data-l="hi" class="'+(I.getLang()==="hi"?"on":"")+'">हिन्दी</button></div>'
    +'<label>'+esc(t("theme"))+'</label><div class="seg" id="st-theme"><button type="button" data-v="system" class="'+(themePref==="system"?"on":"")+'">'+esc(t("theme_system"))+'</button><button type="button" data-v="light" class="'+(themePref==="light"?"on":"")+'">'+esc(t("theme_light"))+'</button><button type="button" data-v="dark" class="'+(themePref==="dark"?"on":"")+'">'+esc(t("theme_dark"))+'</button></div>'
    +'<label>'+esc(t("notifications_pref"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="st-n1" '+(npPosts?"checked":"")+'> '+esc(t("notif_post_approved"))+' / '+esc(t("notif_gift_confirmed"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="st-n2" '+(npGifts?"checked":"")+'> '+esc(t("notif_gift_sent"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="st-n3" '+(npBrands?"checked":"")+'> '+esc(t("notif_brand"))+' / '+esc(t("notif_auction"))+'</label>'
    +'<button class="btn secondary" id="st-save-prefs" style="margin-top:8px">'+esc(t("save"))+'</button></div>'
    +'<div class="card" style="margin-top:12px"><h2>'+esc(t("privacy_section"))+'</h2>'
    +'<label class="check-row"><input type="checkbox" id="st-show" '+(showTotals?"checked":"")+'> '+esc(t("show_history"))+'</label>'
    +'<label class="check-row"><input type="checkbox" id="st-anon" '+(anonDefault?"checked":"")+'> '+esc(t("anon_default"))+'</label>'
    +'<h3 style="margin-top:12px">'+esc(t("blocked_users"))+' ('+S.blocked.length+')</h3>'
    +(S.blocked.length? S.blocked.map(function(b){ return '<div class="kv"><span>'+esc(b)+'</span><button class="btn secondary small" data-unblock="'+esc(b)+'">'+esc(t("unblock"))+'</button></div>'; }).join("") : '<p class="small">'+esc(t("no_blocked"))+'</p>')
    +'<button class="btn secondary" id="st-save-priv" style="margin-top:8px">'+esc(t("save"))+'</button></div>'
    +'<div class="card" style="margin-top:12px"><h2>'+esc(t("support_section"))+'</h2>'
    +'<div style="display:grid;gap:8px"><a class="btn secondary" href="#/help">'+esc(t("help_centre"))+'</a><a class="btn secondary" href="#/verify">'+esc(t("verify_centre"))+'</a><a class="btn secondary" href="#/help?topic=ranking">'+esc(t("topic_ranking"))+'</a><button class="btn secondary" id="st-tour">'+esc(t("tour_replay"))+'</button><a class="btn secondary" href="#/admin">'+esc(t("open_console"))+'</a></div>'
    +'<p class="small" style="margin-top:10px">'+esc(t("ranking_note_settings"))+'</p>'
    +'<p class="small" style="margin-top:10px">'+esc(t("sessions_note"))+'</p></div>'
    +'<div class="card" style="margin-top:12px"><h2>'+esc(t("account_section"))+'</h3>'
    +'<div style="display:grid;gap:8px"><button class="btn secondary" id="st-export">'+esc(t("download_data"))+'</button><button class="btn secondary" id="st-logout">'+esc(t("logout"))+'</button><button class="btn secondary" id="st-logout-all">'+esc(t("logout_all"))+'</button><button class="btn danger" id="st-delete">'+esc(t("delete_account"))+'</button></div>'
    +'<h3 style="margin-top:14px">'+esc(t("sessions_title"))+'</h3><div id="st-sessions"><p class="small">'+esc(t("loading"))+'</p></div>'

    +'<p class="small legal" style="margin-top:12px">'+esc(t("version_note"))+'</p></div>');
  // Data export (items 183/273/429): download profile, bills, gifts,
  // notifications as one JSON file.
  $("#st-tour").onclick=function(){ try{ localStorage.removeItem("sp_tour_seen"); }catch(e){} go("#/swipe"); };
  $("#st-export").onclick=async function(){
    var btn=$("#st-export"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var d=await api("/profile/export");
      var blob=new Blob([JSON.stringify(d, null, 2)], {type:"application/json"});
      var a=document.createElement("a");
      a.href=URL.createObjectURL(blob); a.download="sahay-pay-my-data.json";
      document.body.appendChild(a); a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast(t("data_downloaded"));
    }catch(e){ toast(e.message||t("err_generic"), true); }
    finally{ btn.disabled=false; btn.textContent=t("download_data"); }
  };
  // Active sessions list with per-session revoke (item 112).
  (async function loadSessions(){
    var box=$("#st-sessions"); if(!box) return;
    try{
      var d=await api("/auth/sessions");
      var list=pickList(d, ["sessions"]);
      if(!list.length){ box.innerHTML='<p class="small">'+esc(t("sessions_none"))+'</p>'; return; }
      box.innerHTML=list.map(function(s){
        var dev=(s.userAgent||"").slice(0, 80)||t("session_device_unknown");
        return '<div class="kv"><span><strong>'+(s.current?esc(t("session_current")):esc(dev))+'</strong><br><span class="small">'+esc(t("session_last_seen"))+' '+esc(s.lastSeenAt?timeAgo(s.lastSeenAt):"—")+'</span></span>'
          +(s.current?"":'<button class="btn secondary small" data-revoke="'+esc(s.id)+'">'+esc(t("session_revoke"))+'</button>')+'</div>';
      }).join("");
      $all("[data-revoke]", box).forEach(function(b){
        b.onclick=async function(){
          try{ await api("/auth/sessions/"+encodeURIComponent(b.getAttribute("data-revoke")), {method:"DELETE"}); toast(t("session_revoked")); loadSessions(); }
          catch(e){ toast(e.message||t("err_generic"), true); }
        };
      });
    }catch(e){ box.innerHTML='<p class="small">'+esc(t("err_generic"))+'</p>'; }
  })();
  var newCountry=countryCode(u.country);
  $all("#st-country button").forEach(function(b){ b.onclick=function(){ newCountry=b.getAttribute("data-c"); $all("#st-country button").forEach(function(x){ x.classList.toggle("on", x===b); }); }; });
  $all("#st-lang button").forEach(function(b){ b.onclick=function(){ I.setLang(b.getAttribute("data-l")); $all("#st-lang button").forEach(function(x){ x.classList.toggle("on", x===b); }); applyI18nStatic(); toast(t("language_changed")); route(); }; });
  $all("#st-theme button").forEach(function(b){ b.onclick=function(){ try{ localStorage.setItem("sp_theme", b.getAttribute("data-v")); }catch(e){} applyTheme(); $all("#st-theme button").forEach(function(x){ x.classList.toggle("on", x===b); }); toast(t("theme_changed")); }; });
  $all("[data-unblock]").forEach(function(b){ b.onclick=function(){ var k=b.getAttribute("data-unblock"); S.blocked=S.blocked.filter(function(x){ return x!==k; }); saveBlocked(); route(); }; });
  $("#st-save-profile").onclick=async function(){
    var btn=$("#st-save-profile"); btn.disabled=true; btn.textContent=t("loading");
    try{
      var photoUrl=null; var f=$("#st-photo").files[0];
      if(f){ var up=await uploadFile(f,"avatar"); photoUrl=up.url||up.fileUrl||up.path; }
      var body={displayName:$("#st-name").value.trim(), username:$("#st-username").value.trim(), city:$("#st-city").value.trim(), about:$("#st-about").value.trim(), country:newCountry};
      if(photoUrl) body.photoUrl=photoUrl;
      var res=await api("/profile/me", {method:"PATCH", body:body});
      S.user=res.user||res.profile||S.user;
      if(newCountry!==countryCode(u.country)) toast(t("country_changed"));
      else toast(t("profile_saved"));
      updateTopbar();
    }catch(e){ toast(e.message||t("err_generic"), true); }
    finally{ btn.disabled=false; btn.textContent=t("save"); }
  };
  $("#st-save-prefs").onclick=async function(){
    var b=$("#st-save-prefs"); b.disabled=true; b.textContent=t("loading");
    try{ await api("/profile/me", {method:"PATCH", body:{notifyPrefs:{posts:$("#st-n1").checked, gifts:$("#st-n2").checked, brands:$("#st-n3").checked}}}); toast(t("notification_prefs_saved")); }
    catch(e){ toast(e.message||t("err_generic"), true); }
    finally{ b.disabled=false; b.textContent=t("save"); }
  };
  $("#st-save-priv").onclick=async function(){
    var b=$("#st-save-priv"); b.disabled=true; b.textContent=t("loading");
    try{ await api("/profile/me", {method:"PATCH", body:{showTotals:$("#st-show").checked, anonDefault:$("#st-anon").checked}}); toast(t("saved")); }
    catch(e){ toast(e.message||t("err_generic"), true); }
    finally{ b.disabled=false; b.textContent=t("save"); }
  };
  $("#st-logout").onclick=function(){ confirmDialog(t("logout"), t("logout_confirm"), t("logout"), function(){ doLogout(false); }); };
  $("#st-logout-all").onclick=function(){ confirmDialog(t("logout_all"), t("logout_all_confirm"), t("logout_all"), function(){ doLogout(true); }); };
  $("#st-delete").onclick=function(){
    openModal('<h2>'+esc(t("delete_confirm_title"))+'</h2><p>'+esc(t("delete_confirm_body"))+'</p><label for="del-type">'+esc(t("delete_type_hint"))+'</label><input id="del-type" placeholder="DELETE"><div class="btn-row"><button class="btn secondary" id="del-cancel">'+esc(t("cancel"))+'</button><button class="btn danger" id="del-go">'+esc(t("delete_now"))+'</button></div>');
    $("#del-cancel").onclick=closeSheets;
    $("#del-go").onclick=async function(){
      if($("#del-type").value.trim()!=="DELETE"){ toast(t("delete_type_hint"), true); return; }
      try{ await api("/profile/delete", {method:"POST"}); }catch(e){}
      S.user=null; resetTopbar(); closeSheets(); toast(t("logged_out")); go("#/welcome");
    };
  };
}

/* ---------- help centre ---------- */
/* Full legal documents (English is the binding version; the short summary above each one is translated). */
var LEGAL_TERMS_HTML=
 '<p class="small">Version 1.0 — Last updated 16 November 2026. Effective 16 November 2026. The English version of these terms is the binding version.</p>'
 +'<h2>1. What Sahay Pay is</h2>'

 +'<p>Sahay Pay connects people in Nepal and India who need help with a bill with people willing to help. A supporter pays the person directly, from their own payment app, using the payout details shown in the app. Sahay Pay never holds, receives, processes, or guarantees gift money.</p>'
 +'<p>Payments are currently in Demo Mode. The gift journey is a demonstration: fees shown are quotes and are not collected, and no real money moves through Sahay Pay. Any transfer you make is made by you, from your own payment app, directly to the other person.</p>'
 +'<h2>2. Who can use Sahay Pay</h2>'
 +'<p>Sahay Pay is for adults aged 18 and over only. Anyone under 18 is blocked and no account is created. You must give true information about yourself, and you may only create one account.</p>'
 +'<h2>3. Your account</h2>'
 +'<p>Your account is created from simple questions (name, age, country, city, about you). There is no email address or password. When your account is created you are shown a one-time recovery code: write it down and keep it somewhere safe — it is the only way back into your account if you log out, clear your browser data, or change device, because Sahay Pay never stores the code itself. Your login stays on your device for 30 days. Keep your device secure, and log out on any device you share. You can delete your account in Settings at any time.</p>'
 +'<h2>4. Posting a bill</h2>'

 +'<p>Post only real bills, described honestly. Every post is reviewed by the owner before it goes public, and the owner may approve it, reject it, or ask for changes. A material edit to a live bill sends it back to review. Keep other people personal details out of your photos. A bill may be paused if it is reported, and removed if it breaks these terms.</p>'
 +'<h2>5. Verification</h2>'
 +'<p>Bill, ID, and Name badges are decided by a human reviewer. A badge means the reviewer checked what was shown to them. It is not a promise that a bill is genuine or that a person will use help in a particular way.</p>'
 +'<h2>6. Helping and gifts</h2>'
 +'<p>Gifts are voluntary. A bill counts as helped only when the person confirms they received the money. No contract of sale is formed through Sahay Pay: a gift is a voluntary transfer between two users, and it counts only when the recipient confirms receipt. Sahay Pay cannot reverse a gift and cannot refund you, because the money never passes through Sahay Pay. Never send money you cannot afford to lose. Never share your MPIN, OTP, password, or card details with anyone. Sahay Pay never asks for them.</p>'
 +'<p>If a gift goes wrong, the dispute is between the two users involved. You can report the problem through the Help Centre complaint form and Sahay Pay will look into it and may suspend the account involved, but Sahay Pay cannot reverse a transfer it never held and cannot force a refund.</p>'
 +'<h2>7. Fees</h2>'

 +'<p>The fee shown at the Fee step is the current schedule: in Nepal, Rs 160 on gifts up to Rs 1,600, then 10% of the gift; in India, Rs 100 on gifts up to Rs 1,000, then 10% of the gift. Charity asks are free. While Demo Mode is active, fees are quoted only and are not collected. The fee may change, and the fee shown before you confirm always applies.</p>'
 +'<h2>8. Cross-border help</h2>'
 +'<p>If you help someone across a border, follow your own country law. Indian law generally restricts foreign citizens from donating to individuals in India without registration. Transfers between UPI and Nepal have limits (India to Nepal up to INR 200,000 per transaction; Nepal to India up to INR 15,000 per transaction). This is general information only, not legal advice.</p>'
 +'<h2>9. Brands and auctions</h2>'
 +'<p>Brand asks and auctions are arrangements between users and brands. Sahay Pay does not guarantee any brand deal, introduction, or auction outcome.</p>'
 +'<h2>10. What is not allowed</h2>'
 +'<p>Fake bills, fraud, impersonation, illegal content, harassment, spam, scraping, and attempts to break the service are not allowed. Reported illegal content is removed promptly. Accounts that break these rules may be suspended.</p>'
 +'<h2>11. Your content</h2>'
 +'<p>You keep ownership of what you post. By posting, you allow Sahay Pay to display it on the service. You must have the right to share anything you post.</p>'
 +'<p>If you believe something posted on Sahay Pay infringes your copyright, report it through the Help Centre complaint form. Include: what was copied and where it appears on Sahay Pay, proof that you own it (or act for the owner), and how to reach you. Sahay Pay will review the report and remove content that breaks the rules.</p>'
 +'<h2>12. Liability</h2>'

 +'<p>The service is provided as is. Sahay Pay does not promise that you will receive help, does not guarantee any post, and is not responsible for transfers between users, for what users post, or for losses from using the service, to the fullest extent the law allows.</p>'
 +'<h2>13. Changes to these terms</h2>'
 +'<p>These terms may change. The version shown in the app always applies. If you keep using Sahay Pay after a change, you accept the new terms.</p>'
 +'<h2>14. Governing law and contact</h2>'
 +'<p>These terms are governed by the law of Nepal. By ticking "I agree" and using Sahay Pay, you accept these terms. Under Nepal\'s Electronic Transactions Act, 2063 (2008), electronic records and electronic acceptance form a binding agreement, so these terms bind you even though you never sign a paper copy. Questions or complaints can be sent through the Help Centre complaint form.</p>';
var LEGAL_PRIVACY_HTML=
 '<p class="small">Version 1.0 — Last updated 16 November 2026. Effective 16 November 2026. The English version of this policy is the binding version.</p>'
 +'<h2>1. What we collect</h2>'
 +'<p>Profile: display name, age, country, city, about you, language, and an optional photo. Payout details: your eSewa or Khalti number, UPI ID, or bank details, encrypted and shown publicly only as a masked hint. Bills you post: amount, category, description, bill photo, and payment method. Verification documents, which only the reviewer sees and which are deleted after review. Reports and complaints you send. Session cookies that keep you logged in (see §8 for the list). A scrambled copy (hash) of your one-time recovery code, so we can check a code you enter without ever storing the code itself.</p>'

 +'<p>We do not collect email addresses, passwords, OTPs, MPINs, card numbers, or banking credentials.</p>'
 +'<h2>2. How we use it</h2>'
 +'<p>To run the service and show your bill to helpers; to review posts and keep the service safe; to show your payout details to a helper only at the Send step; and to answer complaints. We do not sell your data. We do not run third-party analytics or advertising trackers.</p>'
 +'<h2>3. Who sees it</h2>'
 +'<p>Your public profile and bill are visible to other users. Your full payout details are shown only to a helper at the Send step, and every reveal is logged. Verification documents are seen only by the reviewer. Our hosting providers, Netlify for the website and Supabase for the database in Mumbai, process data only to run the service.</p>'
 +'<h2>4. How it is protected</h2>'
 +'<p>Payout details are encrypted while stored. The admin console is protected by a PIN. Access is limited to what the service needs. No system is completely secure, and we cannot promise absolute security.</p>'
 +'<h2>5. How long we keep it</h2>'
 +'<p>We keep each kind of data only as long as it is needed:</p>'
 +'<ul><li>Your profile and bills: until you delete them.</li><li>Verification documents: deleted after the review is decided.</li><li>Session records: 30 days for your login, 24 hours for the admin login.</li><li>Audit log entries (what happened and when — never your payout details): 1 year.</li></ul>'
 +'<p>When you delete a bill or your account, it is removed, including its payout details.</p>'
 +'<h2>6. Your rights</h2>'
 +'<p>Edit your profile in Settings. Delete your account in Settings at any time. Ask about your data, or request a copy or deletion, through the Help Centre complaint form. We answer access and export requests within 30 days. We respect your rights under the Individual Privacy Act 2075 of Nepal and the Digital Personal Data Protection Act 2023 of India.</p>'
 +'<h2>7. Children</h2>'
 +'<p>Sahay Pay is for adults aged 18 and over only. We do not knowingly collect data from anyone under 18. Under-18 sign-ups are blocked and no account is created.</p>'
 +'<h2>8. Cookies</h2>'
 +'<p>We use two strictly necessary session cookies and no advertising or tracking cookies. Both are HttpOnly and SameSite=Lax, and are marked Secure whenever the site runs in production mode.</p>'
 +'<table class="cookie-table"><tr><th>Cookie</th><th>Purpose</th><th>Lasts</th></tr><tr><td>sp_session</td><td>Keeps you logged in</td><td>30 days (renewed when you use the app)</td></tr><tr><td>sp_admin</td><td>Keeps the admin console logged in</td><td>24 hours</td></tr></table>'
 +'<h2>9. Changes and contact</h2>'

 +'<p>If this policy changes, the version shown in the app applies. Contact us through the Help Centre complaint form.</p>';
var ABOUT_HTML=
 '<p>Sahay Pay connects people in Nepal and India who need help with a bill with people willing to help. A supporter pays the person directly, from their own payment app, using the payout details shown in the app. Sahay Pay never holds, receives, processes, or guarantees gift money.</p>'
 +'<p>Every post is reviewed by the owner before it goes public. The service is run from Bhairahawa, Nepal, and is currently in Demo Mode: no real payment integration is connected yet, so fees shown are quotes and are not collected.</p>';
var REFUNDS_HTML=
 '<p>No payments are taken while Demo Mode is active, so no refunds arise. Gifts go directly from supporter to recipient, outside Sahay Pay, and Sahay Pay cannot refund or reverse them (see Terms §6).</p>'
 +'<p>When real payments launch, any fee collected through a payment provider will be refunded through that provider, under that provider\'s rules. If a post was fake or the payout details were wrong, report it through the Help Centre complaint form — the owner reviews every report.</p>';
var CONTENT_RULES_HTML=
 '<p>Do not post: fake bills or false claims; defamation; hate speech; threats, harassment, or bullying; misinformation; illegal goods or services; sexual content involving minors (reported to the authorities); other people\'s private details; content you do not have the right to share; spam or scams.</p>'
 +'<p>To report content, use the Help Centre complaint form: include a link to the post, which rule it breaks, and why. Reported content is reviewed by a human. Posts that break these rules are removed, and accounts that break them may be suspended. Copyright reports go through the same form (see Terms §11).</p>';
var HELP_TOPICS=[
  {id:"about", titleKey:"topic_about", body:function(){ return '<p>'+esc(t("about_body"))+'</p>'+ABOUT_HTML; }},
  {id:"helping", titleKey:"topic_helping", body:function(){ return '<p>'+esc(t("how_helping_body"))+'</p>'+neverHoldsHtml()+'<p class="small">'+esc(t("fee_sentence_supporter"))+' '+esc(t("fee_sentence_zero"))+'</p>'+crossBorderHtml(); }},
  {id:"posting", titleKey:"topic_posting", body:function(){ return '<p>'+esc(t("how_posting_body"))+'</p><p>'+esc(t("owner_approval_note"))+'</p>'; }},
  {id:"ranking", titleKey:"topic_ranking", body:function(){ return '<p>'+esc(t("ranking_body"))+'</p><p class="small">'+esc(t("ranking_note_settings"))+'</p>'; }},
  {id:"faq", titleKey:"topic_faq", body:function(){
    var fee=S.config? feeSentence() : "";
    var h='<p><strong>'+esc(fee)+'</strong></p>';
    [["faq_q1","faq_a1"],["faq_q2","faq_a2"],["faq_q3","faq_a3"],["faq_q4","faq_a4"],["faq_q5","faq_a5"],["faq_q6","faq_a6"]].forEach(function(pair){
      h+='<details class="help-topic card"><summary>'+esc(t(pair[0]))+'</summary><p>'+esc(t(pair[1]))+'</p></details>';
    });
    return h;
  }},
  {id:"verification", titleKey:"topic_verification", body:function(){ return '<p>'+esc(t("verify_bill_help"))+'</p><p>'+esc(t("verify_id_help"))+'</p><p>'+esc(t("verify_name_help"))+'</p><p>'+esc(t("verify_biller_help"))+'</p><p class="small">'+esc(t("badge_checked"))+'</p>'; }},
  {id:"fees", titleKey:"topic_fees", body:function(){ return '<p>'+esc(feeSentence())+'</p><p>'+esc(t("charity_free"))+'</p><p>'+esc(t("tip_separate"))+'</p>'; }},
  {id:"refunds", titleKey:"topic_refunds", body:function(){ return '<p>'+esc(t("refunds_body"))+'</p>'+REFUNDS_HTML; }},
  {id:"safety", titleKey:"topic_safety", body:function(){ return '<p>'+esc(t("safety_body"))+'</p><p class="small">'+esc(t("crisis_note"))+'</p>'; }},
  {id:"content-rules", titleKey:"topic_content_rules", body:function(){ return '<p>'+esc(t("content_rules_body"))+'</p>'+CONTENT_RULES_HTML; }},
  {id:"complaints", titleKey:"topic_complaints", body:function(){ return '<p>'+esc(t("complaints_body"))+'</p><div id="complaint-form"></div>'; }},
  {id:"privacy", titleKey:"topic_privacy", body:function(){ return '<p>'+esc(t("privacy_body"))+'</p>'+LEGAL_PRIVACY_HTML+'<p class="legal">'+esc(t("legal_note"))+'</p>'; }},
  {id:"terms", titleKey:"topic_terms", body:function(){ return '<p>'+esc(t("terms_body"))+'</p>'+LEGAL_TERMS_HTML+'<p class="legal">'+esc(t("legal_note"))+'</p>'; }}
];
function renderHelp(id, q){
  var topic=q&&q.topic;
  if(topic){
    var tp=HELP_TOPICS.find(function(x){ return x.id===topic; });
    if(!tp){ go("#/help"); return; }
    view('<a href="#/help" class="small">← '+esc(t("back_to_help"))+'</a><h1 style="margin-top:8px">'+esc(t(tp.titleKey))+'</h1><div class="card">'+tp.body()+'</div>');
    if(topic==="complaints"){
      var form=$("#complaint-form");
      // Honeypot (item 788): hidden "website" field no human ever sees —
      // bots fill it and the server rejects the submission.
      form.innerHTML='<label for="cp-subject">'+esc(t("complaint_subject"))+'</label><input id="cp-subject" maxlength="120" aria-describedby="cp-err"><label for="cp-body">'+esc(t("complaint_body"))+'</label><textarea id="cp-body" maxlength="2000" aria-describedby="cp-err"></textarea><input id="cp-website" name="website" autocomplete="off" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0"><div class="field-err" id="cp-err" role="alert"></div><button class="btn" id="cp-send" style="margin-top:10px">'+esc(t("file_complaint"))+'</button>';
      $("#cp-send").onclick=async function(){
        if(!needUser()) return;
        var s=$("#cp-subject").value.trim(), b=$("#cp-body").value.trim();
        if(!s||!b){ $("#cp-err").textContent=t("err_complaint_fields"); return; }
        $("#cp-err").textContent="";
        var btn=$("#cp-send"); btn.disabled=true; btn.textContent=t("loading");
        try{ await api("/complaints", {method:"POST", body:{subject:s, body:b, website:($("#cp-website").value||"")}}); toast(t("complaint_sent")); var cs=$("#cp-subject"); if(cs) cs.value=""; var cb=$("#cp-body"); if(cb) cb.value=""; }

        catch(e){ toast(e.message||t("err_generic"), true); }
        finally{ btn.disabled=false; btn.textContent=t("file_complaint"); }
      };
    }
    return;
  }
  view('<h1>'+esc(t("help_centre"))+'</h1><p>'+esc(t("help_centre_intro"))+'</p><p class="small">'+esc(t("help_topics_note"))+'</p>'
    +'<label class="sr-only" for="help-search">'+esc(t("search_help"))+'</label><input id="help-search" placeholder="'+esc(t("search_help"))+'" style="margin-bottom:10px">'
    +'<div id="help-list">'+HELP_TOPICS.map(function(tp){ return '<a class="card row-card" href="#/help?topic='+tp.id+'"><div class="grow"><div class="t">'+esc(t(tp.titleKey))+'</div></div><span>›</span></a>'; }).join("")+'</div>');
  $("#help-search").addEventListener("input", function(){
    var s=$("#help-search").value.trim().toLowerCase();
    var list=HELP_TOPICS.filter(function(tp){ return !s || t(tp.titleKey).toLowerCase().indexOf(s)>=0; });
    $("#help-list").innerHTML=list.length? list.map(function(tp){ return '<a class="card row-card" href="#/help?topic='+tp.id+'"><div class="grow"><div class="t">'+esc(t(tp.titleKey))+'</div></div><span>›</span></a>'; }).join("") : '<p>'+esc(t("no_help_results"))+'</p>';
  });
}

/* ---------- notifications ---------- */
function renderNotifications(){
  if(!S.user){ view(emptyState("🔔", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  view('<h1>'+esc(t("notifications"))+'</h1><button class="btn secondary small" id="nt-readall" style="margin-bottom:12px">'+esc(t("mark_all_read"))+'</button><div id="nt-body">'+skeleton(2)+'</div>');
  $("#nt-readall").onclick=async function(){ var b=$("#nt-readall"); b.disabled=true; try{ await api("/notifications/read-all", {method:"POST"}); toast(t("all_read")); load(); updateTopbar(); }catch(e){ toast(e.message||t("err_generic"), true); } finally{ b.disabled=false; } };
  load();
  async function load(){
    var body=$("#nt-body"); if(!body) return;
    try{
      var d=await api("/notifications");
      var list=pickList(d,["notifications"]);
      S.notifCache=list;
      if(!list.length){ body.innerHTML=emptyState("🔔", t("empty_notifications"), t("notifications_empty_action")); return; }
      body.innerHTML=list.map(function(n){
        var unread=!n.is_read&&!n.isRead;
        return '<div class="card list-item" data-nt="'+esc(n.id)+'" tabindex="0" role="button" style="'+(unread?"border-left:3px solid var(--accent)":"opacity:.75")+'">'+(unread?'<span class="chip on" style="margin-bottom:6px">'+esc(t("notif_new"))+'</span>':"")+'<strong>'+esc(n.title||t("unknown_notif"))+'</strong><p class="small" style="margin:4px 0">'+esc(n.body||"")+'</p><p class="small muted">'+esc(timeAgo(n.created_at||n.createdAt))+(n.link?' · <a href="'+esc(n.link)+'">'+esc(t("tap_to_open"))+'</a>':"")+'</p></div>';
      }).join("");
      $all("[data-nt]", body).forEach(function(card){
        card.onclick=async function(){
          var id=card.getAttribute("data-nt");
          var n=list.find(function(x){ return String(x.id)===String(id); });
          try{ await api("/notifications/"+encodeURIComponent(id)+"/read", {method:"POST"}); }catch(e){}
          updateTopbar();
          if(n&&n.link) go(n.link.replace(/^.*(#\/.*)$/,"$1"));
          else load();
        };
        card.addEventListener("keydown", function(e){ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); card.click(); } });
      });
    }catch(e){ body.innerHTML=errBox(e.message); bindErrRetry(load); }
  }
}

/* ---------- verification centre ---------- */
function renderVerify(){
  if(!S.user){ view(emptyState("✅", t("need_profile"), "", '<a class="btn small" href="#/country">'+esc(t("get_started"))+'</a>', "h1")); return; }
  view('<h1>'+esc(t("verify_centre"))+'</h1><p>'+esc(t("verify_centre_intro"))+'</p><div id="vf-body">'+skeleton(2)+'</div>');
  load();
  async function load(){
    var body=$("#vf-body"); if(!body) return;
    var mine=[];
    try{ var d=await api("/verification/mine"); mine=pickList(d,["verifications"]); }catch(e){ /* empty list on failure */ }
    var defs=[
      {type:"bill", label:t("verify_bill"), help:t("verify_bill_help"), kind:"private_proof"},
      {type:"id", label:t("verify_id"), help:t("verify_id_help"), kind:"id_doc"},
      {type:"name", label:t("verify_name"), help:t("verify_name_help"), kind:"private_proof"},
      {type:"biller", label:t("verify_biller"), help:t("verify_biller_help"), kind:"private_proof"}
    ];
    body.innerHTML=defs.map(function(def){
      var v=mine.find(function(x){ return x.type===def.type; });
      var status=v? v.status : "not_submitted";
      var label={not_submitted:t("not_submitted"),submitted:t("submitted"),under_review:t("under_review"),approved:t("approved"),rejected:t("rejected"),more_required:t("more_required")}[status]||status;
      return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(def.label)+'</strong><span class="chip">'+esc(label)+'</span></div>'
        +'<p class="small">'+esc(def.help)+'</p>'
        +(v&&v.reviewer_note?'<p class="small"><strong>'+esc(t("reviewer_msg"))+':</strong> '+esc(v.reviewer_note)+'</p>':"")
        +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><input type="file" id="vf-file-'+def.type+'" accept="image/jpeg,image/png,image/webp,application/pdf" aria-label="'+esc(def.label)+'" style="flex:1;min-width:180px">'
        +'<button class="btn small" data-vf="'+def.type+'" data-kind="'+def.kind+'">'+esc(t("verify_submit"))+'</button></div></div>';
    }).join("");
    $all("[data-vf]", body).forEach(function(btn){
      btn.onclick=async function(){
        var type=btn.getAttribute("data-vf"), kind=btn.getAttribute("data-kind");
        var inp=$("#vf-file-"+type);
        var f=inp.files[0];
        if(!f){ toast(t("verify_upload_first"), true); return; }
        btn.disabled=true; btn.textContent=t("loading");
        try{
          var up=await uploadFile(f, kind);
          var url=up.url||up.fileUrl||up.path;
          await api("/verification", {method:"POST", body:{type:type, docUrl:url}});
          toast(t("verification_submitted")); load();
        }catch(e){ btn.disabled=false; btn.textContent=t("verify_submit"); toast(e.message||t("err_generic"), true); }
      };
    });
  }
}

/* ---------- founder tip ---------- */
function renderFounderTip(q){
  var giftId=q&&q.gift, amountMinor=q?parseInt(q.amount||"0",10):0, cur=(q&&q.currency)||"NPR";
  var opts=[
    {id:"none", label:t("no_tip"), minor:0},
    {id:"5", label:"5% — "+money(Math.round(amountMinor*0.05),cur), minor:Math.round(amountMinor*0.05)},
    {id:"10", label:"10% — "+money(Math.round(amountMinor*0.10),cur), minor:Math.round(amountMinor*0.10)}
  ];
  var sel="none", customMinor=0;
  view('<div class="center-page" style="justify-content:flex-start;padding-top:20px"><div class="slide-ic">💙</div><h1>'+esc(t("founder_tip_title"))+'</h1><p>'+esc(t("founder_tip_body"))+'</p>'
    +(amountMinor?'<p><strong>'+esc(t("your_help"))+': '+esc(money(amountMinor,cur))+'</strong></p>':"")
    +demoHtml()
    +'<div class="card" style="width:100%;max-width:420px;text-align:left"><div class="seg" id="ft-seg" style="flex-wrap:wrap">'+opts.map(function(o){ return '<button type="button" data-v="'+o.id+'" class="'+(o.id==="none"?"on":"")+'">'+esc(o.label)+'</button>'; }).join("")+'<button type="button" data-v="custom">'+esc(t("custom"))+'</button></div>'
    +'<div id="ft-custom-wrap" hidden><label>'+esc(t("tip_custom"))+' ('+(cur==="INR"?"₹":"रू")+')</label><input id="ft-custom" type="number" min="0" step="1"></div>'
    +'<p class="small">'+esc(t("tip_separate"))+'</p>'
    +'<div class="btn-row"><button class="btn secondary" id="ft-skip">'+esc(t("skip_tip"))+'</button><button class="btn" id="ft-send">'+esc(t("submit"))+'</button></div>'
    +'<p class="small legal">'+esc(t("pay_tip_demo"))+'</p></div></div>');
  $all("#ft-seg button").forEach(function(b){
    b.onclick=function(){
      $all("#ft-seg button").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on");
      sel=b.getAttribute("data-v");
      $("#ft-custom-wrap").hidden=sel!=="custom";
    };
  });
  $("#ft-skip").onclick=function(){ go("#/swipe"); };
  $("#ft-send").onclick=function(){
    if(sel==="none"){ go("#/swipe"); return; }
    var amt=sel==="custom"? toMinor($("#ft-custom").value) : (opts.find(function(o){ return o.id===sel; })||{minor:0}).minor;
    if(amt<=0){ toast(t("amount_positive"), true); return; }
    openModal('<h2>'+esc(t("founder_tip_title"))+'</h2>'+demoHtml()+'<p style="margin-top:10px">'+esc(t("pay_tip_demo"))+' '+esc(money(amt,cur))+' — '+esc(giftId?("gift "+giftId):"")+'</p><button class="btn" id="ft-ok">'+esc(t("got_it"))+'</button>');
    $("#ft-ok").onclick=function(){ closeSheets(); go("#/swipe"); };
  };
}

/* ---------- admin ---------- */
function adminNav(active){
  var links=[["dashboard",t("dashboard")],["queue",t("queue")],["users",t("users")],["verifications",t("verifications")],["reports",t("reports")],["fees",t("fees")],["audit",t("audit_log")]];
  return '<div class="admin-nav">'+links.map(function(l){ return '<a href="#/admin/'+l[0]+'" class="'+(active===l[0]?"on":"")+'">'+esc(l[1])+'</a>'; }).join("")+'</div>';
}
function adminGuard(){
  if(!S.admin){
    view('<h1>'+esc(t("admin"))+'</h1>'+emptyState("🔐", t("no_admin"), t("need_login_admin"), '<a class="btn small" href="#/admin">'+esc(t("admin_login"))+'</a>'));
    return false;
  }
  return true;
}
async function checkAdminSession(){
  try{ var d=await api("/admin/metrics"); S.admin=true; return d; }
  catch(e){ S.admin=false; return null; }
}
function renderAdminLogin(){
  view('<h1>'+esc(t("admin"))+'</h1><div id="ad-body">'+skeleton(1)+'</div>');
  (async function(){
    var body=$("#ad-body");
    try{
      var st=await api("/admin/pin-status");
      if(!body.isConnected) return; // navigated away while loading
      if(st.pinSet===false||st.pin_set===false){
        body.innerHTML='<div class="card"><h2>'+esc(t("pin_setup_title"))+'</h2><p>'+esc(t("pin_setup_body"))+'</p><p class="small">'+esc(t("pin_hint"))+'</p>'
          +'<label for="ad-pin">'+esc(t("pin_label"))+'</label><input id="ad-pin" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password" aria-describedby="ad-err">'
          +'<label for="ad-pin2">'+esc(t("confirm_pin"))+'</label><input id="ad-pin2" type="password" inputmode="numeric" maxlength="12" autocomplete="new-password">'
          +'<div class="field-err" id="ad-err" role="alert"></div>'
          +'<button class="btn" id="ad-setup">'+esc(t("set_pin"))+'</button></div>';
        $("#ad-setup").onclick=async function(){
          var p1=$("#ad-pin").value, p2=$("#ad-pin2").value;
          if(p1.length<6||!/^\d+$/.test(p1)){ $("#ad-err").textContent=t("pin_min"); return; }
          if(p1!==p2){ $("#ad-err").textContent=t("pin_mismatch"); return; }
          var btn=$("#ad-setup"); btn.disabled=true; btn.textContent=t("loading");
          try{
            await api("/admin/setup-pin", {method:"POST", body:{pin:p1}});
            if(location.hash.split("?")[0]!=="#/admin") return;
            toast(t("admin_pin_setup_done"));
            renderAdminLogin();
          }catch(e){ if(location.hash.split("?")[0]!=="#/admin") return; btn.disabled=false; btn.textContent=t("set_pin"); toast(e.message||t("err_generic"), true); }
        };
        return;
      }
      body.innerHTML='<div class="card"><h2>'+esc(t("admin_login"))+'</h2><p>'+esc(t("pin_login_body"))+'</p>'
        +'<label for="ad-pin">'+esc(t("pin_label"))+'</label><input id="ad-pin" type="password" inputmode="numeric" maxlength="12" autocomplete="current-password" aria-describedby="ad-err">'
        +'<div class="field-err" id="ad-err" role="alert"></div>'
        +'<button class="btn" id="ad-login">'+esc(t("login"))+'</button>'
        +'<p class="small" style="margin-top:10px">'+esc(t("pin_forgot"))+'</p><p class="small">'+esc(t("session_admin_note"))+'</p></div>'
        +'<div class="card" style="margin-top:12px"><h2>'+esc(t("change_pin"))+'</h2>'
        +'<label for="ad-old">'+esc(t("old_pin"))+'</label><input id="ad-old" type="password" inputmode="numeric" maxlength="12">'
        +'<label for="ad-new">'+esc(t("new_pin"))+'</label><input id="ad-new" type="password" inputmode="numeric" maxlength="12">'
        +'<button class="btn secondary" id="ad-change" style="margin-top:10px">'+esc(t("change_pin"))+'</button></div>';
      $("#ad-login").onclick=async function(){
        var pin=$("#ad-pin").value;
        if(!pin){ $("#ad-err").textContent=t("pin_required"); return; }
        var btn=$("#ad-login"); btn.disabled=true; btn.textContent=t("loading");
        try{
          var lr=await api("/admin/login", {method:"POST", body:{pin:pin}});
          if(lr&&lr.csrfToken) S.adminCsrf=lr.csrfToken;
          S.admin=true;
          if(location.hash.split("?")[0]!=="#/admin") return;
          toast(t("admin_welcome")); go("#/admin/dashboard");
        }catch(e){ btn.disabled=false; btn.textContent=t("login"); var ae=$("#ad-err"); if(ae) ae.textContent=(e.status===401||e.status===403)?t("wrong_pin"):(e.message||t("err_generic")); }

      };
      $("#ad-change").onclick=async function(){
        var oldP=$("#ad-old").value, newP=$("#ad-new").value;
        if(newP.length<6||!/^\d+$/.test(newP)){ toast(t("pin_min"), true); return; }
        var b=$("#ad-change"); b.disabled=true; b.textContent=t("loading");
        try{ await api("/admin/change-pin", {method:"POST", body:{oldPin:oldP, newPin:newP}}); toast(t("pin_changed")); }
        catch(e){ toast(e.message||t("err_generic"), true); }
        finally{ b.disabled=false; b.textContent=t("change_pin"); }
      };
    }catch(e){
      body.innerHTML=errBox(e.message); bindErrRetry(renderAdminLogin);
    }
  })();
}
function adminLogoutBtn(){
  return '<button class="btn ghost" id="ad-logout">'+esc(t("admin_logout"))+'</button>';
}
function bindAdminLogout(){
  var b=$("#ad-logout");
  if(b) b.onclick=async function(){ try{ await api("/admin/logout", {method:"POST"}); }catch(e){} S.admin=false; go("#/admin"); };
}
async function renderAdminDashboard(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("admin"))+' — '+esc(t("dashboard"))+'</h1><p class="small">'+esc(t("admin_metrics_note"))+'</p>'+adminNav("dashboard")+'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  try{
    var d=await api("/admin/metrics");
    var m=d.metrics||d;
    var body=$("#ad-body"); if(!body) return;
    var byStatus=m.billsByStatus||m.bills_by_status||{};
    var totalPosts=Object.keys(byStatus).reduce(function(a,k){ return a+(byStatus[k]||0); }, 0);
    var vol=m.confirmedHelpVolume||m.confirmed_help_volume||[];
    function volFor(cur){ var r=vol.find(function(x){ return x.currency===cur; }); return r? (r.totalMinor!=null?r.totalMinor:r.total_minor||0) : 0; }
    body.innerHTML='<div class="grid2">'
      +statBox(t("total_users"), m.users!=null?m.users:(m.totalUsers||m.total_users||0))
      +statBox(t("total_posts"), totalPosts||m.totalPosts||m.total_posts||0)
      +statBox(t("pending"), m.pendingReviewPackets!=null?m.pendingReviewPackets:(m.pendingPosts||m.pending_posts||m.pending||0))
      +statBox(t("pending_verifications"), m.pendingVerifications!=null?m.pendingVerifications:(m.pending_verifications||0))
      +statBox(t("metrics_confirmed_npr"), money(volFor("NPR")||m.confirmedNprMinor||m.confirmed_npr_minor||0,"NPR"))
      +statBox(t("metrics_confirmed_inr"), money(volFor("INR")||m.confirmedInrMinor||m.confirmed_inr_minor||0,"INR"))
      +statBox(t("open_reports"), m.openReports||m.open_reports||0)
      +statBox(t("open_complaints"), m.openComplaints!=null?m.openComplaints:(m.open_complaints||0))
      +'</div>'
      +'<div class="card" style="margin-top:12px"><h2>'+esc(t("fee_mode"))+'</h2><p>'+esc(t("current_mode"))+': <strong>'+esc((S.config&&S.config.feeMode)||"supporter_fee")+'</strong></p><p class="small">'+esc(feeSentence())+'</p><a class="btn secondary small" href="#/admin/fees">'+esc(t("fees"))+'</a></div>'
      +'<div class="card" style="margin-top:12px"><h2>'+esc(t("maintenance_mode"))+'</h2><p class="small">'+esc(t("maintenance_note"))+'</p><p id="mt-state" class="small">'+esc(t("loading"))+'</p><button class="btn secondary small" id="mt-toggle" disabled>'+esc(t("maintenance_toggle"))+'</button></div>'

      +'<div class="btn-row"><a class="btn" href="#/admin/queue">'+esc(t("admin_queue_cta"))+'</a><a class="btn secondary" href="#/swipe">'+esc(t("back_to_app"))+'</a></div>';
    // Maintenance kill-switch toggle (item 194).
    (async function(){
      var stEl=$("#mt-state"), btn=$("#mt-toggle"); if(!stEl||!btn) return;
      try{
        var cur=await api("/admin/maintenance");
        var on=!!(cur.enabled||cur.maintenance);
        stEl.textContent=on?t("maintenance_is_on"):t("maintenance_is_off");
        btn.disabled=false;
        btn.textContent=on?t("maintenance_turn_off"):t("maintenance_turn_on");
        btn.onclick=async function(){
          btn.disabled=true;
          try{
            var r=await api("/admin/maintenance", {method:"PUT", body:{enabled:!on}});
            on=!!(r.enabled||r.maintenance);
            stEl.textContent=on?t("maintenance_is_on"):t("maintenance_is_off");
            btn.textContent=on?t("maintenance_turn_off"):t("maintenance_turn_on");
            toast(on?t("maintenance_is_on"):t("maintenance_is_off"));
          }catch(e){ toast(e.message||t("err_generic"), true); }
          btn.disabled=false;
        };
      }catch(e){ stEl.textContent=t("err_generic"); }
    })();
    function statBox(l, v){ return '<div class="card stat"><div class="n">'+esc(v)+'</div><div class="l">'+esc(l)+'</div></div>'; }
  }catch(e){
    if(e.status===401) S.admin=false;
    var eb=$("#ad-body"); if(!eb) return;
    if(e.status===401){ go("#/admin"); return; }
    eb.innerHTML=errBox(e.message); bindErrRetry(renderAdminDashboard);
  }
}
function renderAdminQueue(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("queue"))+'</h1><p class="small">'+esc(t("packet_meta"))+'</p>'+adminNav("queue")
    +'<div class="tabs"><button class="tab-btn on" data-s="pending">'+esc(t("pending"))+'</button><button class="tab-btn" data-s="approved">'+esc(t("approved"))+'</button><button class="tab-btn" data-s="rejected">'+esc(t("rejected"))+'</button><button class="tab-btn" data-s="changes_requested">'+esc(t("changes_requested"))+'</button></div>'
    +'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  var status="pending";
  $all(".tab-btn").forEach(function(b){ b.onclick=function(){ status=b.getAttribute("data-s"); $all(".tab-btn").forEach(function(x){ x.classList.toggle("on", x===b); }); load(); }; });
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    body.innerHTML=skeleton(2);
    try{
      var d=await api("/admin/queue?status="+encodeURIComponent(status));
      var packets=pickList(d,["packets","queue"]);
      if(!packets.length){ body.innerHTML=emptyState("📥", t("no_packets"), t("review_queue_empty")); return; }
      body.innerHTML=packets.map(function(pk){
        var pay=pk.payload||pk.payload_json||{};
        if(typeof pay==="string"){ try{ pay=JSON.parse(pay); }catch(e){ pay={}; } }
        var typeLabel={bill:t("packet_bill"),brand:t("packet_brand"),auction:t("packet_auction"),photo:t("packet_photo")}[pk.target_type||pk.targetType]||(pk.target_type||"");
        return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(typeLabel)+'</strong><span class="chip">'+esc(pk.status||"")+'</span></div>'
          +'<p class="small">'+esc(pay.title||pay.name||pk.target_id||"")+' · '+esc(timeAgo(pk.created_at||pk.createdAt))+'</p>'
          +(pay.amountMinor!=null?'<p class="small">'+esc(money(pay.amountMinor, pay.currency||"NPR"))+'</p>':"")
          +'<button class="btn small" data-packet="'+esc(pk.id)+'">'+esc(t("open_packet"))+'</button></div>';
      }).join("");
      $all("[data-packet]", body).forEach(function(btn){
        btn.onclick=function(){
          var pk=packets.find(function(x){ return String(x.id)===String(btn.getAttribute("data-packet")); });
          openPacket(pk);
        };
      });
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
  function openPacket(pk){
    var pay=pk.payload||pk.payload_json||{};
    if(typeof pay==="string"){ try{ pay=JSON.parse(pay); }catch(e){ pay={}; } }
    var rq=pay.requester||pay.seller||{};
    var posterName=rq.displayName||pay.displayName||pay.poster_name||pay.username||"—";
    var posterUser=rq.username||pay.username||"";
    var amt=pay.amountMinor!=null?pay.amountMinor:pay.startBidMinor;
    var hints=Array.isArray(pay.payoutHints)?pay.payoutHints.map(function(h){ return h.hint||(h.method||""); }).join(" · "):(pay.payoutHint||pay.payout_hint||"");
    var memberSince=rq.memberSince||pay.memberSince||"";
    var prevPosts=(rq.approvedPosts!=null||rq.rejectedPosts!=null)?((rq.approvedPosts||0)+" "+t("approved")+" / "+(rq.rejectedPosts||0)+" "+t("rejected")):(pay.prevPosts!=null?pay.prevPosts:(pay.prev_posts!=null?pay.prev_posts:"—"));
    var prevReports=rq.reportsAgainst!=null?rq.reportsAgainst:(pay.prevReports!=null?pay.prevReports:(pay.prev_reports!=null?pay.prev_reports:"—"));
    openSheet('<h2>'+esc(t("review_packet"))+'</h2>'
      +'<div class="kv"><span>'+esc(t("packet_poster"))+'</span><b>'+esc(posterName)+(posterUser?' (@'+esc(posterUser)+')':"")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_amount"))+'</span><b>'+(amt!=null?esc(money(amt, pay.currency||"NPR")):"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_category"))+'</span><b>'+esc(pay.category||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_payout"))+'</span><b>'+esc(hints||"—")+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_account_age"))+'</span><b>'+esc(memberSince?timeAgo(memberSince):(pay.accountAge||pay.account_age||"—"))+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_prev_posts"))+'</span><b>'+esc(prevPosts)+'</b></div>'
      +'<div class="kv"><span>'+esc(t("packet_prev_reports"))+'</span><b>'+esc(prevReports)+'</b></div>'
      +(pay.story?'<h3>'+esc(t("packet_story"))+'</h3><p>'+esc(pay.story)+'</p>':"")
      +(pay.description?'<h3>'+esc(t("details"))+'</h3><p>'+esc(pay.description)+'</p>':"")
      +(pay.photoUrl?'<img class="bill-photo" src="'+esc(pay.photoUrl)+'" alt="'+esc(t("bill_photo_alt"))+'" loading="lazy">':"")
      +(pay.hasPrivateProof||pay.privateProof?'<p class="small">🔒 '+esc(t("packet_proof"))+'</p>':"")
      +(pay.aiNote?'<p class="small muted">'+esc(pay.aiNote)+'</p>':"")
      +(pay.flags&&pay.flags.length?'<h3>'+esc(t("packet_flags"))+'</h3><p class="small">'+esc(t("ai_suggested"))+'</p><ul>'+pay.flags.map(function(f){ return '<li>'+esc(typeof f==="string"?f:JSON.stringify(f))+'</li>'; }).join("")+'</ul>':"")
      +'<label for="pk-reason">'+esc(t("decision_reason"))+'</label><textarea id="pk-reason" maxlength="500" placeholder="'+esc(t("reason_ph"))+'"></textarea>'
      +'<label for="pk-note">'+esc(t("owner_private_note"))+'</label><textarea id="pk-note" maxlength="500"></textarea>'
      +'<div class="field-err" id="pk-err" role="alert"></div>'
      +'<div style="display:grid;gap:8px;margin-top:10px"><button class="btn" data-dec="approve">✓ '+esc(t("approve"))+'</button><button class="btn secondary" data-dec="changes">✎ '+esc(t("request_changes"))+'</button><button class="btn danger" data-dec="reject">✕ '+esc(t("reject"))+'</button></div>');
    $all("[data-dec]").forEach(function(btn){
      btn.onclick=async function(){
        var dec=btn.getAttribute("data-dec");
        var reason=$("#pk-reason").value.trim();
        if(dec!=="approve" && !reason){ $("#pk-err").textContent=t("err_required"); return; }
        btn.disabled=true;
        try{
          await api("/admin/review/"+encodeURIComponent(pk.id), {method:"POST", body:{decision:dec, reason:reason||undefined, privateNote:$("#pk-note").value.trim()||undefined}});
          closeSheets();
          toast(dec==="approve"?t("packet_approved"):dec==="reject"?t("packet_rejected"):t("packet_changes"));
          load();
        }catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
      };
    });
  }
}
function renderAdminUsers(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("users"))+'</h1>'+adminNav("users")
    +'<label class="sr-only" for="au-search">'+esc(t("users_search_ph"))+'</label><input id="au-search" placeholder="'+esc(t("users_search_ph"))+'" style="margin-bottom:10px">'
    +'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  var timer=null;
  $("#au-search").addEventListener("input", function(){ clearTimeout(timer); timer=setTimeout(load, 300); });
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    try{
      var q=$("#au-search").value.trim();
      var d=await api("/admin/users"+(q?"?q="+encodeURIComponent(q):""));
      var users=pickList(d,["users"]);
      if(!users.length){ body.innerHTML=emptyState("👥", t("no_users"), ""); return; }
      body.innerHTML='<div class="card" style="overflow-x:auto"><table class="tbl"><tr><th>'+esc(t("display_name"))+'</th><th>'+esc(t("user_status"))+'</th><th>'+esc(t("user_joined"))+'</th><th>'+esc(t("user_actions"))+'</th></tr>'
        +users.map(function(u){
          var susp=u.suspended?1:0;
          return '<tr><td><strong>'+esc(u.display_name||u.displayName||"")+'</strong><br><span class="small">@'+esc(u.username||"")+' · '+flag(u.country)+' '+esc(u.city||"")+'</span></td><td>'+(susp?'<span class="chip bad">'+esc(t("suspend"))+'</span>':'<span class="chip good">'+esc(t("approved"))+'</span>')+'</td><td>'+esc(u.created_at?fmtDate(u.created_at):"")+'</td>'
          +'<td><button class="btn secondary small" data-u="'+esc(u.id)+'" data-act="'+(susp?"restore":"suspend")+'">'+esc(susp?t("restore"):t("suspend"))+'</button></td></tr>';
        }).join("")+'</table></div>';
      $all("[data-u]", body).forEach(function(btn){
        btn.onclick=async function(){
          var act=btn.getAttribute("data-act"), id=btn.getAttribute("data-u");
          btn.disabled=true;
          try{ await api("/admin/users/"+encodeURIComponent(id)+"/"+act, {method:"POST"}); toast(act==="suspend"?t("user_suspended"):t("user_restored")); load(); }
          catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
        };
      });
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
}
function renderAdminVerifications(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("verifications"))+'</h1>'+adminNav("verifications")+'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    try{
      var d=await api("/admin/verifications");
      var list=pickList(d,["verifications"]);
      if(!list.length){ body.innerHTML=emptyState("✅", t("no_verifications"), ""); return; }
      body.innerHTML=list.map(function(v){
        return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(v.type||"")+'</strong><span class="chip">'+esc(v.status||"")+'</span></div>'
          +'<p class="small">'+esc(v.display_name||v.username||v.user_id||"")+(v.bill_id?' · '+esc(t("bill"))+' '+esc(v.bill_id):"")+' · '+esc(timeAgo(v.created_at||v.createdAt))+'</p>'
          +(v.doc_url?'<p><a href="'+esc(v.doc_url)+'" target="_blank" rel="noopener">'+esc(t("verif_doc"))+'</a></p>':"")
          +'<label for="vn-'+esc(v.id)+'">'+esc(t("verif_note"))+'</label><textarea id="vn-'+esc(v.id)+'" maxlength="500"></textarea>'
          +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
          +'<button class="btn small" data-v="'+esc(v.id)+'" data-dec="approved">'+esc(t("verif_approve"))+'</button>'
          +'<button class="btn secondary small" data-v="'+esc(v.id)+'" data-dec="more_required">'+esc(t("verif_more"))+'</button>'
          +'<button class="btn danger small" data-v="'+esc(v.id)+'" data-dec="rejected">'+esc(t("verif_reject"))+'</button></div></div>';
      }).join("");
      $all("[data-v]", body).forEach(function(btn){
        btn.onclick=async function(){
          var id=btn.getAttribute("data-v"), dec=btn.getAttribute("data-dec");
          btn.disabled=true;
          try{ await api("/admin/verifications/"+encodeURIComponent(id), {method:"POST", body:{decision:dec, note:$("#vn-"+CSS.escape(id)).value.trim()||undefined}}); toast(t("verification_decided")); load(); }
          catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
        };
      });
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
}
function renderAdminReports(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("reports"))+'</h1><p class="small">'+esc(t("admin_reports_note"))+'</p>'+adminNav("reports")+'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    try{
      var d=await api("/admin/reports");
      var list=pickList(d,["reports"]);
      if(!list.length){ body.innerHTML=emptyState("🚩", t("no_reports"), ""); return; }
      body.innerHTML=list.map(function(r){
        return '<div class="card list-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong>'+esc(r.reason||"")+'</strong><span class="chip">'+esc(r.status||"")+'</span></div>'
          +'<p class="small">'+esc(t("reports_target"))+': '+esc(r.target_type||"")+' '+esc(r.target_id||"")+' · '+esc(timeAgo(r.created_at||r.createdAt))+'</p>'
          +(r.note?'<p>'+esc(r.note)+'</p>':"")
          +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">'
          +[["dismiss",t("dismiss")],["hide",t("hide_post")],["pause",t("pause_bill")],["remove",t("remove_bill")],["suspend",t("suspend_account")],["restore",t("restore_bill")]].map(function(a){ return '<button class="btn secondary small" data-r="'+esc(r.id)+'" data-a="'+a[0]+'">'+esc(a[1])+'</button>'; }).join("")
          +'</div></div>';
      }).join("");
      $all("[data-r]", body).forEach(function(btn){
        btn.onclick=async function(){
          btn.disabled=true;
          try{ await api("/admin/reports/"+encodeURIComponent(btn.getAttribute("data-r")), {method:"POST", body:{action:btn.getAttribute("data-a")}}); toast(t("decision_saved")); load(); }
          catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
        };
      });
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
}
function renderAdminFees(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("fees"))+'</h1>'+adminNav("fees")+'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    try{
      var d=await api("/admin/fees");
      var cfg=d.feeConfig||d.fees||{};
      var mode=d.feeMode||(S.config&&S.config.feeMode)||"supporter_fee";
      var npr=cfg.NPR||cfg.npr||{flatMinor:16000,thresholdMinor:160000,percent:10,minMinor:16000};
      var inr=cfg.INR||cfg.inr||{flatMinor:10000,thresholdMinor:100000,percent:10,minMinor:10000};
      var pct=npr.percent!=null?npr.percent:10;
      var tipCfg=d.founderTipConfig||{};
      var tipEnabled=tipCfg.enabled!==false;
      var tipPcts=Array.isArray(tipCfg.optionsPercent)&&tipCfg.optionsPercent.length?tipCfg.optionsPercent.filter(function(x){ return x>0; }).join(","):"5,10";
      body.innerHTML='<div class="card"><h2>'+esc(t("fee_mode"))+'</h2>'
        +'<p>'+esc(t("current_mode"))+': <strong>'+esc(mode==="zero_fee_plus_tip"?t("fee_mode_zero"):t("fee_mode_supporter"))+'</strong></p>'
        +'<p class="small">'+esc(t("staged_mode"))+': '+esc(mode==="zero_fee_plus_tip"?t("fee_mode_supporter"):t("fee_mode_zero"))+' · '+esc(t("pending_decision"))+'</p>'
        +'<p class="small">⚠️ '+esc(t("fee_switch_warn"))+'</p>'
        +'<button class="btn" id="fee-switch">'+esc(t("switch_mode"))+' → '+(mode==="zero_fee_plus_tip"?esc(t("fee_mode_supporter")):esc(t("fee_mode_zero")))+'</button></div>'
        +'<div class="card" style="margin-top:12px"><h2>'+esc(t("fees_current"))+'</h2><p class="small">'+esc(t("fee_config_note"))+' '+esc(t("fees_charity_zero"))+'</p>'
        +'<label for="fee-npr-flat">'+esc(t("fees_npr_flat"))+' (रू)</label><input id="fee-npr-flat" type="number" value="'+esc(fromMinor(npr.flatMinor!=null?npr.flatMinor:npr.flat||16000))+'">'
        +'<label for="fee-npr-thr">'+esc(t("fees_npr_threshold"))+' (रू)</label><input id="fee-npr-thr" type="number" value="'+esc(fromMinor(npr.thresholdMinor!=null?npr.thresholdMinor:npr.threshold||160000))+'">'
        +'<label for="fee-inr-flat">'+esc(t("fees_inr_flat"))+' (₹)</label><input id="fee-inr-flat" type="number" value="'+esc(fromMinor(inr.flatMinor!=null?inr.flatMinor:inr.flat||10000))+'">'
        +'<label for="fee-inr-thr">'+esc(t("fees_inr_threshold"))+' (₹)</label><input id="fee-inr-thr" type="number" value="'+esc(fromMinor(inr.thresholdMinor!=null?inr.thresholdMinor:inr.threshold||100000))+'">'
        +'<label for="fee-pct">'+esc(t("fees_percent"))+'</label><input id="fee-pct" type="number" value="'+esc(pct)+'">'
        +'<button class="btn" id="fee-save" style="margin-top:10px">'+esc(t("fees_save"))+'</button></div>'
        +'<div class="card" style="margin-top:12px"><h2>'+esc(t("founder_tip_config"))+'</h2>'
        +'<label class="check-row"><input type="checkbox" id="tip-enabled" '+(tipEnabled?"checked":"")+'> '+esc(t("tip_enabled"))+'</label>'
        +'<label for="tip-pcts">'+esc(t("tip_percents"))+'</label><input id="tip-pcts" value="'+esc(tipPcts)+'" placeholder="5,10">'
        +'<button class="btn secondary" id="tip-save" style="margin-top:8px">'+esc(t("save_config"))+'</button></div>'
        +'<div class="card" style="margin-top:12px"><h2>'+esc(t("payment_methods"))+'</h2><p class="small">'+esc(t("methods_note"))+'</p><div id="methods-body">'+esc(t("loading"))+'</div></div>';
      $("#fee-switch").onclick=function(){
        var next=mode==="zero_fee_plus_tip"?"supporter_fee":"zero_fee_plus_tip";
        confirmDialog(t("switch_mode"), t("fee_switch_warn"), t("switch_mode"), async function(){
          try{ await api("/admin/fees", {method:"PUT", body:{feeMode:next}}); if(S.config) S.config.feeMode=next; toast(t("config_saved")); load(); }
          catch(e){ toast(e.message||t("err_generic"), true); }
        });
      };
      $("#fee-save").onclick=async function(){
        var b=$("#fee-save"); b.disabled=true; b.textContent=t("loading");
        try{
          var pct2=parseFloat($("#fee-pct").value);
          var nprFlat=toMinor($("#fee-npr-flat").value), inrFlat=toMinor($("#fee-inr-flat").value);
          await api("/admin/fees", {method:"PUT", body:{feeConfig:{
            NPR:{flatMinor:nprFlat, thresholdMinor:toMinor($("#fee-npr-thr").value), percent:pct2, minMinor:nprFlat},
            INR:{flatMinor:inrFlat, thresholdMinor:toMinor($("#fee-inr-thr").value), percent:pct2, minMinor:inrFlat}
          }}});
          toast(t("config_saved"));
        }catch(e){ toast(e.message||t("err_generic"), true); }
        finally{ b.disabled=false; b.textContent=t("fees_save"); }
      };
      $("#tip-save").onclick=async function(){
        var b=$("#tip-save"); b.disabled=true; b.textContent=t("loading");
        try{ await api("/admin/fees", {method:"PUT", body:{founderTipConfig:{enabled:$("#tip-enabled").checked, optionsPercent:[0].concat($("#tip-pcts").value.split(",").map(function(x){ return parseFloat(x.trim()); }).filter(function(x){ return !isNaN(x)&&x>0; })), defaultPercent:0}}}); toast(t("config_saved")); }
        catch(e){ toast(e.message||t("err_generic"), true); }
        finally{ b.disabled=false; b.textContent=t("save_config"); }
      };
      try{
        var md=await api("/admin/methods");
        var pm=md.paymentMethods||{};
        var mb=$("#methods-body");
        if(mb){
          var rows=[];
          ["NP","IN"].forEach(function(cc){
            (pm[cc]||[]).forEach(function(m){
              rows.push('<div class="kv"><span>'+esc(m.name||m.id||"")+' ('+esc(cc)+')</span><button class="btn secondary small" data-m="'+esc(m.id)+'" data-c="'+esc(cc)+'" data-en="'+(m.enabled?"0":"1")+'">'+esc(m.enabled?t("method_enabled"):t("method_disabled"))+'</button></div>');
            });
          });
          mb.innerHTML=rows.length?rows.join(""):'<p class="small">'+esc(t("no_methods"))+'</p>';
          $all("[data-m]", mb).forEach(function(btn){
            btn.onclick=async function(){
              btn.disabled=true;
              try{
                var cc2=btn.getAttribute("data-c"), mid=btn.getAttribute("data-m"), en=btn.getAttribute("data-en")==="1";
                (pm[cc2]||[]).forEach(function(m){ if(m.id===mid) m.enabled=en; });
                await api("/admin/methods", {method:"PUT", body:{paymentMethods:pm}}); toast(t("config_saved")); load();
              }catch(e){ btn.disabled=false; toast(e.message||t("err_generic"), true); }
            };
          });
        }
      }catch(e){ var mb2=$("#methods-body"); if(mb2) mb2.innerHTML='<p class="small">'+esc(e.message||"")+'</p>'; }
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
}
function renderAdminAudit(){
  if(!adminGuard()) return;
  view('<h1>'+esc(t("audit_log"))+'</h1>'+adminNav("audit")
    +'<div style="display:flex;gap:8px;margin-bottom:10px"><label class="sr-only" for="audit-filter">'+esc(t("audit_filter"))+'</label><input id="audit-filter" placeholder="'+esc(t("audit_filter"))+'" style="flex:1"><button class="btn secondary small" id="audit-export">'+esc(t("export_audit"))+'</button></div>'
    +'<div id="ad-body">'+skeleton(2)+'</div>'+adminLogoutBtn());
  bindAdminLogout();
  var rows=[];
  $("#audit-filter").addEventListener("input", draw);
  $("#audit-export").onclick=function(){
    if(!rows.length) return;
    var csv="when,actor,action,target\n"+rows.map(function(r){ return [r.created_at||r.createdAt||"", r.actor_type||r.actorType||"", r.action||"", (r.target_type||"")+"/"+(r.target_id||"")].map(function(x){ return '"'+String(x).replace(/"/g,'""')+'"'; }).join(","); }).join("\n");
    var blob=new Blob([csv], {type:"text/csv"});
    var a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="sahay-pay-audit.csv"; a.click();
    toast(t("audit_exported"));
  };
  load();
  async function load(){
    var body=$("#ad-body"); if(!body) return;
    try{
      var d=await api("/admin/audit");
      rows=pickList(d,["audit","logs","entries"]);
      draw();
    }catch(e){
      if(e.status===401){ S.admin=false; if(!body.isConnected) return; go("#/admin"); return; }
      body.innerHTML=errBox(e.message); bindErrRetry(load);
    }
  }
  function draw(){
    var body=$("#ad-body"); if(!body) return;
    var f=$("#audit-filter").value.trim().toLowerCase();
    var list=rows.filter(function(r){ return !f || String(r.action||"").toLowerCase().indexOf(f)>=0 || String(r.actor_type||"").toLowerCase().indexOf(f)>=0; });
    if(!list.length){ body.innerHTML=emptyState("📋", t("no_audit"), ""); return; }
    body.innerHTML='<div class="card" style="overflow-x:auto"><table class="tbl"><tr><th>'+esc(t("audit_when"))+'</th><th>'+esc(t("audit_who"))+'</th><th>'+esc(t("audit_what"))+'</th><th>'+esc(t("audit_target"))+'</th></tr>'
      +list.map(function(r){ return '<tr><td>'+esc(timeAgo(r.created_at||r.createdAt))+'</td><td>'+esc((r.actor_type||"")+" "+(r.actor_id||""))+'</td><td>'+esc(r.action||"")+'</td><td>'+esc((r.target_type||"")+" "+(r.target_id||""))+'</td></tr>'; }).join("")+'</table></div>';
  }
}

/* ---------- boot ---------- */
async function boot(){
  if(S.booted) return; S.booted=true;
  // /config, /auth/me and the admin session check are independent — fetch
  // in parallel (each is a slow serverless round trip; sequential boot
  // cost ~2s+ even warm). checkAdminSession restores the 24h sp_admin
  // cookie so the owner is not PIN-gated after every reload.
  var settled=await Promise.allSettled([api("/config"), api("/auth/me"), checkAdminSession()]);
  var cfgR=settled[0], meR=settled[1];
  // Maintenance kill switch on (item 194): show the maintenance state
  // instead of the app.
  var maint=null;
  [cfgR, meR].forEach(function(r){ if(r.status==="rejected"&&r.reason&&r.reason.status===503&&r.reason.code==="MAINTENANCE") maint=r.reason; });
  if(maint){ renderMaintenance(maint.message); return; }
  S.config=cfgR.status==="fulfilled"?cfgR.value:null;
  var me=meR.status==="fulfilled"?meR.value:null;
  S.user=(me&&me.user)||null;
  if(me&&me.csrfToken) S.csrfToken=me.csrfToken;
  if(S.user&&S.user.language) I.setLang(S.user.language);
  if(S.user&&S.user.country) S.country=countryCode(S.user.country);

  if(!location.hash) location.hash="#/splash";
  updateSavedBadge();
  route();
  window.addEventListener("online", function(){ hideOfflineBanner(); toast(t("session_restored")); });
  window.addEventListener("offline", function(){ showOfflineBanner(true); });
  if(navigator.onLine===false) showOfflineBanner(true);
  var ob=$("#offline-retry"); if(ob) ob.addEventListener("click", function(){ hideOfflineBanner(); route(); });
  var sk=document.querySelector(".skip-link");
  if(sk) sk.addEventListener("click", function(e){ e.preventDefault(); var m=$("#view"); if(m) m.focus(); });
  if("serviceWorker" in navigator){
    try{ navigator.serviceWorker.register("/sw.js").catch(function(){ /* offline shell is best-effort */ }); }catch(e){ /* unsupported */ }
  }
}
document.addEventListener("DOMContentLoaded", boot);
if(document.readyState!=="loading") boot();
})();
