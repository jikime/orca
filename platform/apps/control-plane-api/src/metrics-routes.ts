import { collectDeadLetterMetrics, collectOutboxMetrics, type PieDatabase } from '@pie/persistence'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { extractBearerToken } from './request-authentication'
import type { RealtimeGateway } from './realtime-gateway'

export type MetricsRoutesDeps = {
  db: PieDatabase
  gateway: RealtimeGateway
  // When set, /internal/* requires this operator bearer. When absent (unit tests),
  // the routes stay open — production always provisions it.
  operatorToken?: string
}

// A single dependency-free ops page (no build step, no framework) that reads the
// JSON metrics + health + discovery via fetch. Dev/ops convenience only — the
// deploy path is an OpenTelemetry Collector + Grafana (observability profile).
const OPS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Pie Control Plane — ops</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;margin:2rem;max-width:52rem}
  h1{font-size:1.2rem}
  section{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}
  code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(11rem,1fr));gap:.5rem}
  .tile{background:#f7f7f7;border-radius:6px;padding:.6rem}
  .tile b{display:block;font-size:1.4rem}
  pre{white-space:pre-wrap;word-break:break-all}
</style></head>
<body>
<h1>Pie Control Plane — ops dashboard</h1>
<p>Dev/ops convenience. Production observability is the OTel Collector + Grafana profile.</p>
<section><h2>Readiness</h2><div id="ready">…</div></section>
<section><h2>Metrics</h2><div id="metrics" class="grid">…</div></section>
<section><h2>Instance</h2><pre id="discovery">…</pre></section>
<script>
async function j(u){const r=await fetch(u);return{ok:r.ok,status:r.status,body:await r.json().catch(()=>null)}}
function tile(k,v){return '<div class="tile">'+k+'<b>'+v+'</b></div>'}
async function refresh(){
  const ready=await j('/readyz');
  document.getElementById('ready').textContent=ready.ok?'ready':'NOT READY ('+ready.status+')';
  const m=await j('/internal/metrics');
  if(m.ok){const o=m.body.outbox,dl=m.body.deadLetter,rt=m.body.realtime;
    document.getElementById('metrics').innerHTML=[
      tile('outbox published',o.published),tile('outbox pending',o.pending),
      tile('dead letters',dl.parked),tile('claim lag (s)',o.claimLagSeconds),
      tile('realtime clients',rt.connectedClients),tile('delivered',rt.deliveredMessages)
    ].join('');}
  const d=await j('/.well-known/pie');
  if(d.ok)document.getElementById('discovery').textContent=JSON.stringify(d.body,null,2);
}
refresh();setInterval(refresh,5000);
</script>
</body></html>`

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRoutesDeps): void {
  // Operator authz for /internal/*: a config-provisioned bearer (documented interim
  // before full operator admin). Returns true when the request may proceed.
  const authorizeOperator = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!deps.operatorToken) {
      return true
    }
    if (extractBearerToken(request.headers.authorization) === deps.operatorToken) {
      return true
    }
    void reply.code(401).send({ code: 'UNAUTHENTICATED', status: 401 })
    return false
  }

  app.get('/internal/metrics', async (request, reply) => {
    if (!authorizeOperator(request, reply)) {
      return reply
    }
    const outbox = await collectOutboxMetrics(deps.db)
    const deadLetter = await collectDeadLetterMetrics(deps.db)
    return {
      collectedAt: new Date().toISOString(),
      outbox,
      deadLetter,
      realtime: {
        connectedClients: deps.gateway.connectionCount(),
        deliveredMessages: deps.gateway.deliveredMessageCount()
      }
    }
  })

  app.get('/internal/ops', async (request, reply) => {
    if (!authorizeOperator(request, reply)) {
      return reply
    }
    return reply.type('text/html').send(OPS_HTML)
  })
}
