import {cutRequest,templateTransfers,type FractureRequest,type FractureReply} from "./fractureJobs.js";

const scope=self as unknown as {onmessage:((event:MessageEvent<FractureRequest>)=>void)|null;postMessage(message:FractureReply,transfer?:Transferable[]):void};
scope.onmessage=(event)=>{
 const request=event.data,start=performance.now();
 try{const pieces=cutRequest(request);scope.postMessage({id:request.id,ok:true,pieces,ms:performance.now()-start},templateTransfers(pieces));}
 catch{scope.postMessage({id:request.id,ok:false});}
};
