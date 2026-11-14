/** Runs only inside the sandboxed document. All reports are scoped to that iframe by the parent. */
export const CANVAS_PAGER_SHIM = `<script data-xw-pager>(function(){
var last=1, requestId="", reporting=false, revision=0;
function slides(){
 var selectors=["[data-xw-slide]",".reveal .slides > section","section.slide","[data-slide]",".slide","main > section","body > section","article > section"];
 for(var i=0;i<selectors.length;i++){var list=document.querySelectorAll(selectors[i]);if(list.length)return Array.from(list);}
 return [document.body];
}
function report(error){
 var list=slides(), current=last;
 for(var i=0;i<list.length;i++)if(list[i].classList.contains("active")||list[i].classList.contains("current")||list[i].classList.contains("present")){current=i+1;break;}
 parent.postMessage({type:"xiaowang:position",requestId:requestId,page:current,totalPages:list.length,title:document.title,error:error||""},"*");
}
function flip(page,id){
 var currentRevision=++revision;
 requestId=id||"";
 var n=Number(page),list=slides();
 if(!Number.isInteger(n)||n<1||n>list.length){report("请求页码超出材料范围");return;}
 last=n;
 try{
  if(window.Reveal&&typeof window.Reveal.slide==="function")window.Reveal.slide(n-1);
  else{
   var chosen=list[n-1], hidden=list.some(function(el){return getComputedStyle(el).display==="none";});
   if(hidden||list.some(function(el){return el.classList.contains("slide");}))list.forEach(function(el,i){el.style.display=i===n-1?"block":"none";el.classList.toggle("active",i===n-1);el.setAttribute("aria-hidden",String(i!==n-1));});
   chosen.scrollIntoView({block:"start",behavior:"instant"});
  }
  requestAnimationFrame(function(){requestAnimationFrame(function(){
   if(currentRevision!==revision)return;
   var target=list[n-1],cs=getComputedStyle(target);
   report(cs.display==="none"||cs.visibility==="hidden"||target.getBoundingClientRect().height===0?"指定页面未能显示":"");
  });});
 }catch(e){report(String(e));}
}
window.addEventListener("message",function(e){if(e.source===parent&&e.data&&e.data.type==="xiaowang:page")flip(e.data.page,e.data.requestId);});
function changed(){if(reporting)return;reporting=true;requestAnimationFrame(function(){reporting=false;report();});}
window.addEventListener("keydown",function(){setTimeout(changed,80);});
window.addEventListener("click",function(){setTimeout(changed,80);});
})();</script>`;
export function withCanvasPager(html: string): string {
  if (html.includes("data-xw-pager")) return html;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${CANVAS_PAGER_SHIM}</body>`) : `${html}${CANVAS_PAGER_SHIM}`;
}
