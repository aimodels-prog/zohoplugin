import * as db from "./db.js";
export function startReportWorker(runJob, intervalMs=2000) {
  let stopped=false,running=false;
  const tick=async()=>{
    if(stopped||running)return;
    running=true;
    try {const job=await db.claimReportJob();if(job)await runJob(job);}
    catch {console.error(JSON.stringify({category:"report_worker",outcome:"error"}));}
    finally {running=false;}
  };
  const timer=setInterval(tick,intervalMs);timer.unref();
  return ()=>{stopped=true;clearInterval(timer);};
}
