var At=r=>{throw TypeError(r)};var it=(r,t,e)=>t.has(r)||At("Cannot "+e);var x=(r,t,e)=>(it(r,t,"read from private field"),e?e.call(r):t.get(r)),R=(r,t,e)=>t.has(r)?At("Cannot add the same private member more than once"):t instanceof WeakSet?t.add(r):t.set(r,e),W=(r,t,e,s)=>(it(r,t,"write to private field"),s?s.call(r,e):t.set(r,e),e),K=(r,t,e)=>(it(r,t,"access private method"),e);var Y=globalThis,Z=Y.ShadowRoot&&(Y.ShadyCSS===void 0||Y.ShadyCSS.nativeShadow)&&"adoptedStyleSheets"in Document.prototype&&"replace"in CSSStyleSheet.prototype,ot=Symbol(),bt=new WeakMap,M=class{constructor(t,e,s){if(this._$cssResult$=!0,s!==ot)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=t,this.t=e}get styleSheet(){let t=this.o,e=this.t;if(Z&&t===void 0){let s=e!==void 0&&e.length===1;s&&(t=bt.get(e)),t===void 0&&((this.o=t=new CSSStyleSheet).replaceSync(this.cssText),s&&bt.set(e,t))}return t}toString(){return this.cssText}},St=r=>new M(typeof r=="string"?r:r+"",void 0,ot),nt=(r,...t)=>{let e=r.length===1?r[0]:t.reduce((s,i,o)=>s+(n=>{if(n._$cssResult$===!0)return n.cssText;if(typeof n=="number")return n;throw Error("Value passed to 'css' function must be a 'css' function result: "+n+". Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.")})(i)+r[o+1],r[0]);return new M(e,r,ot)},Et=(r,t)=>{if(Z)r.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let e of t){let s=document.createElement("style"),i=Y.litNonce;i!==void 0&&s.setAttribute("nonce",i),s.textContent=e.cssText,r.appendChild(s)}},at=Z?r=>r:r=>r instanceof CSSStyleSheet?(t=>{let e="";for(let s of t.cssRules)e+=s.cssText;return St(e)})(r):r;var{is:Kt,defineProperty:Yt,getOwnPropertyDescriptor:Zt,getOwnPropertyNames:Gt,getOwnPropertySymbols:Qt,getPrototypeOf:Xt}=Object,g=globalThis,wt=g.trustedTypes,te=wt?wt.emptyScript:"",ee=g.reactiveElementPolyfillSupport,k=(r,t)=>r,j={toAttribute(r,t){switch(t){case Boolean:r=r?te:null;break;case Object:case Array:r=r==null?r:JSON.stringify(r)}return r},fromAttribute(r,t){let e=r;switch(t){case Boolean:e=r!==null;break;case Number:e=r===null?null:Number(r);break;case Object:case Array:try{e=JSON.parse(r)}catch{e=null}}return e}},G=(r,t)=>!Kt(r,t),xt={attribute:!0,type:String,converter:j,reflect:!1,useDefault:!1,hasChanged:G};Symbol.metadata??(Symbol.metadata=Symbol("metadata")),g.litPropertyMetadata??(g.litPropertyMetadata=new WeakMap);var m=class extends HTMLElement{static addInitializer(t){this._$Ei(),(this.l??(this.l=[])).push(t)}static get observedAttributes(){return this.finalize(),this._$Eh&&[...this._$Eh.keys()]}static createProperty(t,e=xt){if(e.state&&(e.attribute=!1),this._$Ei(),this.prototype.hasOwnProperty(t)&&((e=Object.create(e)).wrapped=!0),this.elementProperties.set(t,e),!e.noAccessor){let s=Symbol(),i=this.getPropertyDescriptor(t,s,e);i!==void 0&&Yt(this.prototype,t,i)}}static getPropertyDescriptor(t,e,s){let{get:i,set:o}=Zt(this.prototype,t)??{get(){return this[e]},set(n){this[e]=n}};return{get:i,set(n){let l=i?.call(this);o?.call(this,n),this.requestUpdate(t,l,s)},configurable:!0,enumerable:!0}}static getPropertyOptions(t){return this.elementProperties.get(t)??xt}static _$Ei(){if(this.hasOwnProperty(k("elementProperties")))return;let t=Xt(this);t.finalize(),t.l!==void 0&&(this.l=[...t.l]),this.elementProperties=new Map(t.elementProperties)}static finalize(){if(this.hasOwnProperty(k("finalized")))return;if(this.finalized=!0,this._$Ei(),this.hasOwnProperty(k("properties"))){let e=this.properties,s=[...Gt(e),...Qt(e)];for(let i of s)this.createProperty(i,e[i])}let t=this[Symbol.metadata];if(t!==null){let e=litPropertyMetadata.get(t);if(e!==void 0)for(let[s,i]of e)this.elementProperties.set(s,i)}this._$Eh=new Map;for(let[e,s]of this.elementProperties){let i=this._$Eu(e,s);i!==void 0&&this._$Eh.set(i,e)}this.elementStyles=this.finalizeStyles(this.styles)}static finalizeStyles(t){let e=[];if(Array.isArray(t)){let s=new Set(t.flat(1/0).reverse());for(let i of s)e.unshift(at(i))}else t!==void 0&&e.push(at(t));return e}static _$Eu(t,e){let s=e.attribute;return s===!1?void 0:typeof s=="string"?s:typeof t=="string"?t.toLowerCase():void 0}constructor(){super(),this._$Ep=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this._$Em=null,this._$Ev()}_$Ev(){this._$ES=new Promise(t=>this.enableUpdating=t),this._$AL=new Map,this._$E_(),this.requestUpdate(),this.constructor.l?.forEach(t=>t(this))}addController(t){(this._$EO??(this._$EO=new Set)).add(t),this.renderRoot!==void 0&&this.isConnected&&t.hostConnected?.()}removeController(t){this._$EO?.delete(t)}_$E_(){let t=new Map,e=this.constructor.elementProperties;for(let s of e.keys())this.hasOwnProperty(s)&&(t.set(s,this[s]),delete this[s]);t.size>0&&(this._$Ep=t)}createRenderRoot(){let t=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return Et(t,this.constructor.elementStyles),t}connectedCallback(){this.renderRoot??(this.renderRoot=this.createRenderRoot()),this.enableUpdating(!0),this._$EO?.forEach(t=>t.hostConnected?.())}enableUpdating(t){}disconnectedCallback(){this._$EO?.forEach(t=>t.hostDisconnected?.())}attributeChangedCallback(t,e,s){this._$AK(t,s)}_$ET(t,e){let s=this.constructor.elementProperties.get(t),i=this.constructor._$Eu(t,s);if(i!==void 0&&s.reflect===!0){let o=(s.converter?.toAttribute!==void 0?s.converter:j).toAttribute(e,s.type);this._$Em=t,o==null?this.removeAttribute(i):this.setAttribute(i,o),this._$Em=null}}_$AK(t,e){let s=this.constructor,i=s._$Eh.get(t);if(i!==void 0&&this._$Em!==i){let o=s.getPropertyOptions(i),n=typeof o.converter=="function"?{fromAttribute:o.converter}:o.converter?.fromAttribute!==void 0?o.converter:j;this._$Em=i;let l=n.fromAttribute(e,o.type);this[i]=l??this._$Ej?.get(i)??l,this._$Em=null}}requestUpdate(t,e,s,i=!1,o){if(t!==void 0){let n=this.constructor;if(i===!1&&(o=this[t]),s??(s=n.getPropertyOptions(t)),!((s.hasChanged??G)(o,e)||s.useDefault&&s.reflect&&o===this._$Ej?.get(t)&&!this.hasAttribute(n._$Eu(t,s))))return;this.C(t,e,s)}this.isUpdatePending===!1&&(this._$ES=this._$EP())}C(t,e,{useDefault:s,reflect:i,wrapped:o},n){s&&!(this._$Ej??(this._$Ej=new Map)).has(t)&&(this._$Ej.set(t,n??e??this[t]),o!==!0||n!==void 0)||(this._$AL.has(t)||(this.hasUpdated||s||(e=void 0),this._$AL.set(t,e)),i===!0&&this._$Em!==t&&(this._$Eq??(this._$Eq=new Set)).add(t))}async _$EP(){this.isUpdatePending=!0;try{await this._$ES}catch(e){Promise.reject(e)}let t=this.scheduleUpdate();return t!=null&&await t,!this.isUpdatePending}scheduleUpdate(){return this.performUpdate()}performUpdate(){if(!this.isUpdatePending)return;if(!this.hasUpdated){if(this.renderRoot??(this.renderRoot=this.createRenderRoot()),this._$Ep){for(let[i,o]of this._$Ep)this[i]=o;this._$Ep=void 0}let s=this.constructor.elementProperties;if(s.size>0)for(let[i,o]of s){let{wrapped:n}=o,l=this[i];n!==!0||this._$AL.has(i)||l===void 0||this.C(i,void 0,o,l)}}let t=!1,e=this._$AL;try{t=this.shouldUpdate(e),t?(this.willUpdate(e),this._$EO?.forEach(s=>s.hostUpdate?.()),this.update(e)):this._$EM()}catch(s){throw t=!1,this._$EM(),s}t&&this._$AE(e)}willUpdate(t){}_$AE(t){this._$EO?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(t)),this.updated(t)}_$EM(){this._$AL=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this._$ES}shouldUpdate(t){return!0}update(t){this._$Eq&&(this._$Eq=this._$Eq.forEach(e=>this._$ET(e,this[e]))),this._$EM()}updated(t){}firstUpdated(t){}};m.elementStyles=[],m.shadowRootOptions={mode:"open"},m[k("elementProperties")]=new Map,m[k("finalized")]=new Map,ee?.({ReactiveElement:m}),(g.reactiveElementVersions??(g.reactiveElementVersions=[])).push("2.1.2");var I=globalThis,Pt=r=>r,Q=I.trustedTypes,Ct=Q?Q.createPolicy("lit-html",{createHTML:r=>r}):void 0,Mt="$lit$",y=`lit$${Math.random().toFixed(9).slice(2)}$`,kt="?"+y,se=`<${kt}>`,S=document,L=()=>S.createComment(""),D=r=>r===null||typeof r!="object"&&typeof r!="function",ft=Array.isArray,re=r=>ft(r)||typeof r?.[Symbol.iterator]=="function",lt=`[ 	
\f\r]`,H=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ot=/-->/g,Tt=/>/g,A=RegExp(`>|${lt}(?:([^\\s"'>=/]+)(${lt}*=${lt}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`,"g"),Ut=/'/g,Nt=/"/g,jt=/^(?:script|style|textarea|title)$/i,mt=r=>(t,...e)=>({_$litType$:r,strings:t,values:e}),E=mt(1),we=mt(2),xe=mt(3),$=Symbol.for("lit-noChange"),p=Symbol.for("lit-nothing"),Rt=new WeakMap,b=S.createTreeWalker(S,129);function Ht(r,t){if(!ft(r)||!r.hasOwnProperty("raw"))throw Error("invalid template strings array");return Ct!==void 0?Ct.createHTML(t):t}var ie=(r,t)=>{let e=r.length-1,s=[],i,o=t===2?"<svg>":t===3?"<math>":"",n=H;for(let l=0;l<e;l++){let a=r[l],d,h,c=-1,u=0;for(;u<a.length&&(n.lastIndex=u,h=n.exec(a),h!==null);)u=n.lastIndex,n===H?h[1]==="!--"?n=Ot:h[1]!==void 0?n=Tt:h[2]!==void 0?(jt.test(h[2])&&(i=RegExp("</"+h[2],"g")),n=A):h[3]!==void 0&&(n=A):n===A?h[0]===">"?(n=i??H,c=-1):h[1]===void 0?c=-2:(c=n.lastIndex-h[2].length,d=h[1],n=h[3]===void 0?A:h[3]==='"'?Nt:Ut):n===Nt||n===Ut?n=A:n===Ot||n===Tt?n=H:(n=A,i=void 0);let f=n===A&&r[l+1].startsWith("/>")?" ":"";o+=n===H?a+se:c>=0?(s.push(d),a.slice(0,c)+Mt+a.slice(c)+y+f):a+y+(c===-2?l:f)}return[Ht(r,o+(r[e]||"<?>")+(t===2?"</svg>":t===3?"</math>":"")),s]},z=class r{constructor({strings:t,_$litType$:e},s){let i;this.parts=[];let o=0,n=0,l=t.length-1,a=this.parts,[d,h]=ie(t,e);if(this.el=r.createElement(d,s),b.currentNode=this.el.content,e===2||e===3){let c=this.el.content.firstChild;c.replaceWith(...c.childNodes)}for(;(i=b.nextNode())!==null&&a.length<l;){if(i.nodeType===1){if(i.hasAttributes())for(let c of i.getAttributeNames())if(c.endsWith(Mt)){let u=h[n++],f=i.getAttribute(c).split(y),J=/([.?@])?(.*)/.exec(u);a.push({type:1,index:o,name:J[2],strings:f,ctor:J[1]==="."?ct:J[1]==="?"?dt:J[1]==="@"?pt:C}),i.removeAttribute(c)}else c.startsWith(y)&&(a.push({type:6,index:o}),i.removeAttribute(c));if(jt.test(i.tagName)){let c=i.textContent.split(y),u=c.length-1;if(u>0){i.textContent=Q?Q.emptyScript:"";for(let f=0;f<u;f++)i.append(c[f],L()),b.nextNode(),a.push({type:2,index:++o});i.append(c[u],L())}}}else if(i.nodeType===8)if(i.data===kt)a.push({type:2,index:o});else{let c=-1;for(;(c=i.data.indexOf(y,c+1))!==-1;)a.push({type:7,index:o}),c+=y.length-1}o++}}static createElement(t,e){let s=S.createElement("template");return s.innerHTML=t,s}};function P(r,t,e=r,s){if(t===$)return t;let i=s!==void 0?e._$Co?.[s]:e._$Cl,o=D(t)?void 0:t._$litDirective$;return i?.constructor!==o&&(i?._$AO?.(!1),o===void 0?i=void 0:(i=new o(r),i._$AT(r,e,s)),s!==void 0?(e._$Co??(e._$Co=[]))[s]=i:e._$Cl=i),i!==void 0&&(t=P(r,i._$AS(r,t.values),i,s)),t}var ht=class{constructor(t,e){this._$AV=[],this._$AN=void 0,this._$AD=t,this._$AM=e}get parentNode(){return this._$AM.parentNode}get _$AU(){return this._$AM._$AU}u(t){let{el:{content:e},parts:s}=this._$AD,i=(t?.creationScope??S).importNode(e,!0);b.currentNode=i;let o=b.nextNode(),n=0,l=0,a=s[0];for(;a!==void 0;){if(n===a.index){let d;a.type===2?d=new q(o,o.nextSibling,this,t):a.type===1?d=new a.ctor(o,a.name,a.strings,this,t):a.type===6&&(d=new ut(o,this,t)),this._$AV.push(d),a=s[++l]}n!==a?.index&&(o=b.nextNode(),n++)}return b.currentNode=S,i}p(t){let e=0;for(let s of this._$AV)s!==void 0&&(s.strings!==void 0?(s._$AI(t,s,e),e+=s.strings.length-2):s._$AI(t[e])),e++}},q=class r{get _$AU(){return this._$AM?._$AU??this._$Cv}constructor(t,e,s,i){this.type=2,this._$AH=p,this._$AN=void 0,this._$AA=t,this._$AB=e,this._$AM=s,this.options=i,this._$Cv=i?.isConnected??!0}get parentNode(){let t=this._$AA.parentNode,e=this._$AM;return e!==void 0&&t?.nodeType===11&&(t=e.parentNode),t}get startNode(){return this._$AA}get endNode(){return this._$AB}_$AI(t,e=this){t=P(this,t,e),D(t)?t===p||t==null||t===""?(this._$AH!==p&&this._$AR(),this._$AH=p):t!==this._$AH&&t!==$&&this._(t):t._$litType$!==void 0?this.$(t):t.nodeType!==void 0?this.T(t):re(t)?this.k(t):this._(t)}O(t){return this._$AA.parentNode.insertBefore(t,this._$AB)}T(t){this._$AH!==t&&(this._$AR(),this._$AH=this.O(t))}_(t){this._$AH!==p&&D(this._$AH)?this._$AA.nextSibling.data=t:this.T(S.createTextNode(t)),this._$AH=t}$(t){let{values:e,_$litType$:s}=t,i=typeof s=="number"?this._$AC(t):(s.el===void 0&&(s.el=z.createElement(Ht(s.h,s.h[0]),this.options)),s);if(this._$AH?._$AD===i)this._$AH.p(e);else{let o=new ht(i,this),n=o.u(this.options);o.p(e),this.T(n),this._$AH=o}}_$AC(t){let e=Rt.get(t.strings);return e===void 0&&Rt.set(t.strings,e=new z(t)),e}k(t){ft(this._$AH)||(this._$AH=[],this._$AR());let e=this._$AH,s,i=0;for(let o of t)i===e.length?e.push(s=new r(this.O(L()),this.O(L()),this,this.options)):s=e[i],s._$AI(o),i++;i<e.length&&(this._$AR(s&&s._$AB.nextSibling,i),e.length=i)}_$AR(t=this._$AA.nextSibling,e){for(this._$AP?.(!1,!0,e);t!==this._$AB;){let s=Pt(t).nextSibling;Pt(t).remove(),t=s}}setConnected(t){this._$AM===void 0&&(this._$Cv=t,this._$AP?.(t))}},C=class{get tagName(){return this.element.tagName}get _$AU(){return this._$AM._$AU}constructor(t,e,s,i,o){this.type=1,this._$AH=p,this._$AN=void 0,this.element=t,this.name=e,this._$AM=i,this.options=o,s.length>2||s[0]!==""||s[1]!==""?(this._$AH=Array(s.length-1).fill(new String),this.strings=s):this._$AH=p}_$AI(t,e=this,s,i){let o=this.strings,n=!1;if(o===void 0)t=P(this,t,e,0),n=!D(t)||t!==this._$AH&&t!==$,n&&(this._$AH=t);else{let l=t,a,d;for(t=o[0],a=0;a<o.length-1;a++)d=P(this,l[s+a],e,a),d===$&&(d=this._$AH[a]),n||(n=!D(d)||d!==this._$AH[a]),d===p?t=p:t!==p&&(t+=(d??"")+o[a+1]),this._$AH[a]=d}n&&!i&&this.j(t)}j(t){t===p?this.element.removeAttribute(this.name):this.element.setAttribute(this.name,t??"")}},ct=class extends C{constructor(){super(...arguments),this.type=3}j(t){this.element[this.name]=t===p?void 0:t}},dt=class extends C{constructor(){super(...arguments),this.type=4}j(t){this.element.toggleAttribute(this.name,!!t&&t!==p)}},pt=class extends C{constructor(t,e,s,i,o){super(t,e,s,i,o),this.type=5}_$AI(t,e=this){if((t=P(this,t,e,0)??p)===$)return;let s=this._$AH,i=t===p&&s!==p||t.capture!==s.capture||t.once!==s.once||t.passive!==s.passive,o=t!==p&&(s===p||i);i&&this.element.removeEventListener(this.name,this,s),o&&this.element.addEventListener(this.name,this,t),this._$AH=t}handleEvent(t){typeof this._$AH=="function"?this._$AH.call(this.options?.host??this.element,t):this._$AH.handleEvent(t)}},ut=class{constructor(t,e,s){this.element=t,this.type=6,this._$AN=void 0,this._$AM=e,this.options=s}get _$AU(){return this._$AM._$AU}_$AI(t){P(this,t)}};var oe=I.litHtmlPolyfillSupport;oe?.(z,q),(I.litHtmlVersions??(I.litHtmlVersions=[])).push("3.3.3");var It=(r,t,e)=>{let s=e?.renderBefore??t,i=s._$litPart$;if(i===void 0){let o=e?.renderBefore??null;s._$litPart$=i=new q(t.insertBefore(L(),o),o,void 0,e??{})}return i._$AI(r),i};var B=globalThis,_=class extends m{constructor(){super(...arguments),this.renderOptions={host:this},this._$Do=void 0}createRenderRoot(){var e;let t=super.createRenderRoot();return(e=this.renderOptions).renderBefore??(e.renderBefore=t.firstChild),t}update(t){let e=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(t),this._$Do=It(e,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this._$Do?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this._$Do?.setConnected(!1)}render(){return $}};_._$litElement$=!0,_.finalized=!0,B.litElementHydrateSupport?.({LitElement:_});var ne=B.litElementPolyfillSupport;ne?.({LitElement:_});(B.litElementVersions??(B.litElementVersions=[])).push("4.2.2");var ae={attribute:!0,type:String,converter:j,reflect:!1,hasChanged:G},le=(r=ae,t,e)=>{let{kind:s,metadata:i}=e,o=globalThis.litPropertyMetadata.get(i);if(o===void 0&&globalThis.litPropertyMetadata.set(i,o=new Map),s==="setter"&&((r=Object.create(r)).wrapped=!0),o.set(e.name,r),s==="accessor"){let{name:n}=e;return{set(l){let a=t.get.call(this);t.set.call(this,l),this.requestUpdate(n,a,r,!0,l)},init(l){return l!==void 0&&this.C(n,void 0,r,l),l}}}if(s==="setter"){let{name:n}=e;return function(l){let a=this[n];t.call(this,l),this.requestUpdate(n,a,r,!0,l)}}throw Error("Unsupported decorator location: "+s)};function X(r){return(t,e)=>typeof e=="object"?le(r,t,e):((s,i,o)=>{let n=i.hasOwnProperty(o);return i.constructor.createProperty(o,s),n?Object.getOwnPropertyDescriptor(i,o):void 0})(r,t,e)}function $t(r){return X({...r,state:!0,attribute:!1})}var O=(r,t,e)=>(e.configurable=!0,e.enumerable=!0,Reflect.decorate&&typeof t!="object"&&Object.defineProperty(r,t,e),e);var he;function Lt(r){return(t,e)=>O(t,e,{get(){return(this.renderRoot??he??(he=document.createDocumentFragment())).querySelectorAll(r)}})}var Dt={ATTRIBUTE:1,CHILD:2,PROPERTY:3,BOOLEAN_ATTRIBUTE:4,EVENT:5,ELEMENT:6},zt=r=>(...t)=>({_$litDirective$:r,values:t}),tt=class{constructor(t){}get _$AU(){return this._$AM._$AU}_$AT(t,e,s){this._$Ct=t,this._$AM=e,this._$Ci=s}_$AS(t,e){return this.update(t,e)}update(t,e){return this.render(...e)}};var qt=zt(class extends tt{constructor(r){if(super(r),r.type!==Dt.ATTRIBUTE||r.name!=="class"||r.strings?.length>2)throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.")}render(r){return" "+Object.keys(r).filter(t=>r[t]).join(" ")+" "}update(r,[t]){if(this.st===void 0){this.st=new Set,r.strings!==void 0&&(this.nt=new Set(r.strings.join(" ").split(/\s/).filter(s=>s!=="")));for(let s in t)t[s]&&!this.nt?.has(s)&&this.st.add(s);return this.render(t)}let e=r.element.classList;for(let s of this.st)s in t||(e.remove(s),this.st.delete(s));for(let s in t){let i=!!t[s];i===this.st.has(s)||this.nt?.has(s)||(i?(e.add(s),this.st.add(s)):(e.remove(s),this.st.delete(s)))}return $}});function*Bt(r,t){if(r!==void 0){let e=0;for(let s of r)yield t(s,e++)}}function et(r,t,e){return r?t(r):e?.(r)}var ce=Object.defineProperty,de=Object.getOwnPropertyDescriptor,rt=(r,t,e,s)=>{for(var i=s>1?void 0:s?de(t,e):t,o=r.length-1,n;o>=0;o--)(n=r[o])&&(i=(s?n(t,e,i):n(i))||i);return s&&i&&ce(t,e,i),i};function pe(r){return r instanceof RegExp}function gt(r){return r===null?"null":Array.isArray(r)?"array":r.constructor.name.toLowerCase()}function V(r){return r!==Object(r)}function ue(r,{nodeCount:t=3,maxLength:e=15}={}){let s=Array.isArray(r),i=Object.keys(r),o=i.slice(0,t),n=[],l=h=>{switch(gt(h)){case"object":return Object.keys(h).length===0?"{ }":"{ ... }";case"array":return h.length===0?"[ ]":"[ ... ]";case"string":return`"${h.substring(0,e)}${h.length>e?"...":""}"`;default:return String(h)}},a=[];for(let h of o){let c=[],u=r[h];s||c.push(`${h}: `),c.push(l(u)),a.push(c.join(""))}i.length>t&&a.push("..."),n.push(a.join(", "));let d=n.join("");return s?`[ ${d} ]`:`{ ${d} }`}function*vt(r){let t=[[r,"",[]]];for(;t.length;){let[e,s,i]=t.shift();if(s&&(yield[e,s,i]),!V(e))for(let[o,n]of Object.entries(e))t.push([n,`${s}${s?".":""}${o}`,[...i,s]])}}function fe(r,t){let e=r.split("."),s=t.split("."),i=a=>a==="*",o=a=>a==="**",n=0,l=0;for(;n<e.length;){let a=s[l],d=e[n];if(a===d||i(a))l++,n++;else if(o(a))l++,n=e.length-(s.length-l);else return!1}return l===s.length}var me={fromAttribute:r=>r&&r.trim()?JSON.parse(r):void 0,toAttribute:r=>JSON.stringify(r)},yt=r=>r!==void 0,Jt=(r,t)=>pe(t)?!!r.match(t):fe(r,t),$e=(r,t)=>t.split(".").reduce((e,s)=>e[s],r),Vt=(r,t)=>e=>({expanded:{...e.expanded,[r]:yt(t)?!!t:!e.expanded[r]}}),st=(r,t)=>(e,s)=>{let i={};if(r)for(let[,o,n]of vt(s.data))Jt(o,r)&&(i[o]=t,n.forEach(l=>i[l]=t));return{expanded:i}},ge=r=>(t,e)=>{let s={};if(r)for(let[,i,o]of vt(e.data))Jt(i,r)?(s[i]=!1,o.forEach(n=>s[n]=!1)):s[i]=!0;return{filtered:s}},ye=()=>()=>({filtered:{}}),Ft=r=>()=>({highlight:r}),_e=nt`
    :where(:host) {
        --background-color: #2a2f3a;
        --color: #f8f8f2;
        --string-color: #a3eea0;
        --number-color: #d19a66;
        --boolean-color: #4ba7ef;
        --null-color: #df9cf3;
        --property-color: #6fb3d2;
        --preview-color: rgba(222, 175, 143, 0.9);
        --highlight-color:  #c92a2a;
        --outline-color: #e0e4e5;
        --outline-width: 1px;
        --outline-style: dotted;

        --font-family: Nimbus Mono PS, Courier New, monospace;
        --font-size: 1rem;
        --line-height: 1.2rem;

        --indent-size: 0.5rem;
        --indentguide-size: 1px;
        --indentguide-style: solid;
        --indentguide-color: #495057;
        --indentguide-color-active: #ced4da;
        --indentguide: var(--indentguide-size) var(--indentguide-style) var(--indentguide-color);
        --indentguide-active: var(--indentguide-size) var(--indentguide-style) var(--indentguide-color-active);
    }

    :host {
        display: block;
        background-color: var(--background-color);
        color: var(--color);
        font-family: var(--font-family);
        font-size: var(--font-size);
        line-height: var(--line-height);
    }

    :focus {
        outline-color: var(--outline-color);
        outline-width: var(--outline-width);
        outline-style: var(--outline-style);
    }

    .preview {
        color: var(--preview-color);
    }

    .null {
        color: var(--null-color);
    }

    .key {
        color: var(--property-color);
        display: inline-flex;
        align-items: flex-start;
    }

    .collapsable::before {
        display: inline-flex;
        font-size: 0.8em;
        content: '▶';
        width: var(--line-height);
        height: var(--line-height);
        align-items: center;
        justify-content: center;

        transition: transform 195ms ease-out;
        transform: rotate(90deg);

        color: inherit;
    }

    .collapsable--collapsed::before {
        transform: rotate(0);
    }

    .collapsable {
        cursor: pointer;
        user-select: none;
    }

    .string {
        color: var(--string-color);
    }

    .number {
        color: var(--number-color);
    }

    .boolean {
        color: var(--boolean-color);
    }

    ul {
        padding: 0;
        clear: both;
    }

    ul,
    li {
        list-style: none;
        position: relative;
    }

    li ul > li {
        position: relative;
        margin-left: calc(var(--indent-size) + var(--line-height));
        padding-left: 0px;
    }

    ul ul::before {
        content: '';
        border-left: var(--indentguide);
        position: absolute;
        left: calc(var(--line-height) / 2 - var(--indentguide-size));
        top: 0.2rem;
        bottom: 0.2rem;
    }

    ul ul:hover::before {
        border-left: var(--indentguide-active);
    }

    mark {
        background-color: var(--highlight-color);
    }
`,F,T,U,w,Wt,_t,N,v=(N=class extends _{constructor(){super();R(this,w);R(this,F);R(this,T);R(this,U);this.state={expanded:{},filtered:{},highlight:null},this.lastFocusedItem=null,W(this,F,e=>s=>{s.preventDefault(),this.setState(Vt(e))}),W(this,T,e=>{let s=e.target;e.target===this&&K(this,w,_t).call(this,this.lastFocusedItem||this.nodeElements[0]),s.matches('[role="treeitem"]')&&(this.lastFocusedItem&&(this.lastFocusedItem.tabIndex=-1),this.lastFocusedItem=s,this.tabIndex=-1,s.tabIndex=0)}),W(this,U,e=>{let s=e.relatedTarget;(!s||!this.contains(s))&&(this.tabIndex=0)}),this.addEventListener("focusin",x(this,T)),this.addEventListener("focusout",x(this,U))}static customRenderer(e,s){return JSON.stringify(e)}async setState(e){let s=this.state;this.state={...s,...e(s,this)}}connectedCallback(){!this.hasAttribute("data")&&!yt(this.data)&&this.setAttribute("data",this.innerText),this.setAttribute("role","node"),this.setAttribute("tabindex","0"),super.connectedCallback()}expand(e){this.setState(st(e,!0))}expandAll(){this.setState(st("**",!0))}collapseAll(){this.setState(st("**",!1))}collapse(e){this.setState(st(e,!1))}*search(e){for(let[s,i]of vt(this.data))V(s)&&String(s).match(e)&&(this.expand(i),this.updateComplete.then(()=>{let o=this.shadowRoot.querySelector(`[data-path="${i}"]`);o.scrollIntoView({behavior:"smooth",inline:"center",block:"center"}),o.focus()}),this.setState(Ft(i)),yield{value:s,path:i});this.setState(Ft(null))}filter(e){this.setState(ge(e))}resetFilter(){this.setState(ye())}renderObject(e,s){return E`
            <ul part="object" role="group">
                ${Bt(Object.entries(e),([i,o])=>{let n=s?`${s}.${i}`:i,l=V(o),a=this.state.expanded[n];return this.state.filtered[n]?p:E`
                              <li
                                  part="property"
                                  role="treeitem"
                                  data-path="${n}"
                                  aria-expanded="${a?"true":"false"}"
                                  tabindex="-1"
                                  .hidden="${this.state.filtered[n]}"
                                  aria-hidden="${this.state.filtered[n]}"
                              >
                                  <span
                                      part="key"
                                      class="${qt({key:i,collapsable:!l,"collapsable--collapsed":!this.state.expanded[n]})}"
                                      @click="${l?null:x(this,F).call(this,n)}"
                                  >
                                      ${i}:
                                      ${et(!l&&!a,()=>this.renderNodePreview(o))}
                                  </span>

                                  ${et(l||a,()=>this.renderValue(o,n))}
                              </li>
                          `})}
            </ul>
        `}renderValue(e,s=""){return V(e)?this.renderPrimitive(e,s):this.renderObject(e,s)}renderNodePreview(e){return E`<span part="preview" class="preview"> ${ue(e)} </span>`}renderPrimitive(e,s){let i=this.state.highlight,o=gt(e),n=this.constructor.customRenderer(e,s),l=E`
            <span part="primitive primitive-${o}" class="${gt(e)}"> ${n} </span>
        `;return s===i?E`<mark part="highlight">${l}</mark>`:l}render(){let e=this.data;return E`
            <div
                part="base"
                @keydown=${K(this,w,Wt)}
                @focusin="${x(this,T)}"
                @focusout="${x(this,U)}"
            >
                ${et(yt(e),()=>this.renderValue(e))}
            </div>
        `}},F=new WeakMap,T=new WeakMap,U=new WeakMap,w=new WeakSet,Wt=function(e){if(!["ArrowDown","ArrowUp","ArrowRight","ArrowLeft","Home","End"].includes(e.key))return;let s=[...this.nodeElements],i=this.matches(":dir(ltr)"),o=this.matches(":dir(rtl)");if(s.length>0){e.preventDefault();let n=s.findIndex(u=>u.matches(":focus")),l=s[n],a=this.state.expanded[l.dataset.path],d=V($e(this.data,l.dataset.path)),h=u=>{let f=s[Math.max(Math.min(u,s.length-1),0)];K(this,w,_t).call(this,f)},c=u=>{this.setState(Vt(l.dataset.path,u))};e.key==="ArrowDown"?h(n+1):e.key==="ArrowUp"?h(n-1):i&&e.key==="ArrowRight"||o&&e.key==="ArrowLeft"?!l||a||d?h(n+1):c(!0):i&&e.key==="ArrowLeft"||o&&e.key==="ArrowRight"?!l||!a||d?h(n-1):c(!1):e.key==="Home"?h(0):e.key==="End"&&h(s.length-1)}},_t=function(e){e.focus()},N.styles=[_e],N);rt([X({converter:me,type:Object})],v.prototype,"data",2);rt([$t()],v.prototype,"state",2);rt([$t()],v.prototype,"lastFocusedItem",2);rt([Lt('[role="treeitem"]')],v.prototype,"nodeElements",2);customElements.define("json-viewer",v);export{v as JsonViewer};
