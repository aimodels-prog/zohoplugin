import { setTimeout as delay } from "node:timers/promises";
import { integerSetting } from "./security.js";
const slots=new Map();
export function reserveRequest(key,now=Date.now(),interval=integerSetting("ZOHO_MIN_REQUEST_INTERVAL_MS",700,0,60000)) {
  const at=Math.max(now,slots.get(key)||0);slots.set(key,at+interval);
  if(slots.size>2000)for(const [k,t] of slots)if(t<now)slots.delete(k);
  return at-now;
}
export async function paceRequest(key) {const wait=reserveRequest(key);if(wait)await delay(wait);}
export function retryDelay(value,now=Date.now()) {
  if(value==null)return 0;
  const seconds=Number(value);
  if(Number.isFinite(seconds))return Math.min(86400000,Math.max(0,seconds*1000));
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?Math.min(86400000,Math.max(0,timestamp-now)):0;
}
