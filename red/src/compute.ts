import fallback from "../resources/origin-ranges.json";
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {stageDir} from 'red/cli';
import type {Opts} from 'red/workflow';
import {orchestrate,plan_deployment,read_deployment,validate,backend_plan,source_cidrs} from 'colors-compute-red';
export const topology=[{count:1}];
// The AWS adapter accepts IPv4 sources only, so a symbolic range set loses its
// IPv6 members there. Explicit operator CIDRs are left alone and validate
// against the provider as written.
export function ipv4Only(opts:Opts,ranges:string[]):string[]{return opts['provider-compute']==='aws'?ranges.filter(range=>!range.includes(':')):ranges;}
export function requirements(opts:Opts){const ssh=source_cidrs(opts,'ssh-sources','n8n-ssh-sources');let http=source_cidrs(opts,'http-sources','n8n-http-sources');if(http.length===1&&http[0]==='cloudflare')http=ipv4Only(opts,fallback);return {single_host:true,security:{egress:'all',private_filter:false,ingress:[{id:'ssh',protocol:'tcp',from_port:22,to_port:22,sources:ssh},...[80,443].map(port=>({id:'web-'+port,protocol:'tcp',from_port:port,to_port:port,sources:http}))]},legacy_state_keys:[opts.profile+'/n8n-infrastructure.tfstate']};}
export function errors(opts:Opts):string[]{try{const errors=validate(opts);if(errors.length)return errors;plan_deployment(opts,topology,requirements(opts));return [];}catch{return ['invalid singleton compute requirements'];}}
function attach(opts:Opts,result:any):Opts{if(!['planned','ready','present','destroyed'].includes(result.status))return {...opts,'red/exit':1,'red/err':result.errors?.join('\n')||'compute lifecycle refused'};if(result.status==='destroyed')return {...opts,'red/exit':0,'n8n/already-destroyed':true};const node=result.cluster.nodes.find((n:any)=>n.node_id===result.cluster.entry_node_id);return {...opts,...node,'red/exit':0,'colors-compute/cluster':result.cluster,'colors-compute/key':result.key,'ssh-private-key-path':result.key?.private_key_path??node.ssh_identity_file};}
function sorted(value:any):any{return Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;}
// Plan on build and dry-run; orchestrate otherwise. `env` is the subprocess
// environment the library hands its providers, so a caller can add AWS
// credentials supplied as COLORS_PAR_AWS_* without exporting them globally.
export async function infrastructureStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts>{const planning=opts['red/event']==='build'||opts['red/dry-run'],result=planning?plan_deployment(opts,topology,requirements(opts)):await orchestrate(opts,topology,requirements(opts),env);if(planning){const root=stageDir(opts,'compute'),stacks:[string,Record<string,any>][]=[['shared',result.documents.shared],...Object.entries(result.documents.nodes).map(([id,docs])=>['nodes/'+id,docs] as [string,Record<string,any>])];for(const [suffix,docs]of stacks){const dir=join(root,suffix),key=suffix==='shared'?result.state_keys.shared:result.state_keys.nodes[suffix.split('/')[1]!];mkdirSync(dir,{recursive:true});for(const [name,document]of Object.entries({...docs,'backend.tf.json':backend_plan(opts,key).config}))writeFileSync(join(dir,name),JSON.stringify(sorted(document),null,2)+'\n');}}return attach(opts,result);}
// Read the recorded deployment before a delete. With a managed S3 state bucket
// any status but `present` means the application stages have nothing left to
// act on, and the delete goes straight to backend finalization: the bucket may
// already be half-finalized, or gone, and neither is a compute state to adopt.
export async function loadStep(opts:Opts,env:Record<string,string|undefined>=process.env):Promise<Opts>{if(opts['red/dry-run'])return opts;const result=await read_deployment(opts,env,undefined,requirements(opts));if(opts['s3-bucket-mode']==='managed'&&result.status!=='present')return {...opts,'red/exit':0,'n8n/finalize-only':true};return attach(opts,result);}

export function symbolicHttp(opts:Opts):boolean{try{const sources=source_cidrs(opts,'http-sources','n8n-http-sources');return sources.length===1&&sources[0]==='cloudflare';}catch{return false;}}
