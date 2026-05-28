/**
 * fetch-linear.js
 * Regenera data.json jalando la API de Linear.
 * Filtra proyectos cuyo nombre contiene "Expansion into" o están en la
 * iniciativa "Latam Expansion".
 *
 * Requiere: LINEAR_API_KEY en env.
 * Uso local: LINEAR_API_KEY=xxx node scripts/fetch-linear.js
 */

const fs   = require("fs");
const path = require("path");

const LINEAR_API = "https://api.linear.app/graphql";
const API_KEY    = process.env.LINEAR_API_KEY;

if (!API_KEY) { console.error("ERROR: LINEAR_API_KEY no definida."); process.exit(1); }

async function gql(query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: API_KEY },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ── Queries ───────────────────────────────────────────────────────────────────

const ALL_PROJECTS_QUERY = `
  query {
    projects(first: 50) {
      nodes {
        id name url targetDate startDate completedAt
        status { type name }
        lead { name }
        initiatives { nodes { id name } }
        projectMilestones { nodes { id name progress targetDate } }
      }
    }
  }
`;

const STATUS_UPDATE_QUERY = `
  query($projectId: String!) {
    project(id: $projectId) {
      projectUpdates(first: 1, orderBy: { field: createdAt, direction: DESC }) {
        nodes { body health createdAt }
      }
    }
  }
`;

const DISCOVERY_ISSUES_QUERY = `
  query {
    issues(
      filter: {
        team: { name: { eq: "Data & Operations" } }
        title: { containsIgnoreCase: "discovery" }
      }
      orderBy: { field: updatedAt, direction: DESC }
      first: 50
    ) {
      nodes {
        id identifier title url
        status { type name }
        completedAt
      }
    }
  }
`;

// ── Country helpers ───────────────────────────────────────────────────────────

const COUNTRY_MAP = {
  "ecuador":       { id: "EC", name: "Ecuador",         flag: "🇪🇨" },
  "panama":        { id: "PA", name: "Panamá",           flag: "🇵🇦" },
  "costa rica":    { id: "CR", name: "Costa Rica",       flag: "🇨🇷" },
  "guatemala":     { id: "GT", name: "Guatemala",        flag: "🇬🇹" },
  "mexico":        { id: "MX", name: "México",           flag: "🇲🇽" },
  "brazil":        { id: "BR", name: "Brasil",           flag: "🇧🇷" },
  "brasil":        { id: "BR", name: "Brasil",           flag: "🇧🇷" },
  "argentina":     { id: "AR", name: "Argentina",        flag: "🇦🇷" },
  "chile":         { id: "CL", name: "Chile",            flag: "🇨🇱" },
  "colombia":      { id: "CO", name: "Colombia",         flag: "🇨🇴" },
  "peru":          { id: "PE", name: "Perú",             flag: "🇵🇪" },
  "dominican":     { id: "DO", name: "Rep. Dominicana",  flag: "🇩🇴" },
  "bolivia":       { id: "BO", name: "Bolivia",          flag: "🇧🇴" },
  "venezuela":     { id: "VE", name: "Venezuela",        flag: "🇻🇪" },
  "salvador":      { id: "SV", name: "El Salvador",      flag: "🇸🇻" },
  "guyana":        { id: "GY", name: "Guyana",           flag: "🇬🇾" },
  "honduras":      { id: "HN", name: "Honduras",         flag: "🇭🇳" },
  "nicaragua":     { id: "NI", name: "Nicaragua",        flag: "🇳🇮" },
  "paraguay":      { id: "PY", name: "Paraguay",         flag: "🇵🇾" },
  "uruguay":       { id: "UY", name: "Uruguay",          flag: "🇺🇾" },
};

function matchCountry(text) {
  const lower = text.toLowerCase();
  for (const [kw, data] of Object.entries(COUNTRY_MAP)) {
    if (lower.includes(kw)) return data;
  }
  return null;
}

function isExpansionProject(proj) {
  const nameMatch = /expansion into/i.test(proj.name) ||
                    /data enablement/i.test(proj.name);
  const initiativeMatch = (proj.initiatives?.nodes || [])
    .some(i => /latam expansion/i.test(i.name));
  return nameMatch || initiativeMatch;
}

function milestoneLabel(name) {
  const n = name.toLowerCase();
  if (n.includes("discovery"))                          return "Discovery";
  if (n.includes("congress") || n.includes("congreso")) return "Congreso";
  if (n.includes("government") || n.includes("gobierno")) return "Gobierno";
  if (n.includes("cross") || n.includes("transvers") || n.includes("service")) return "Transversales";
  if (n.includes("legal") || n.includes("commercial"))  return "Legal & Comercial";
  return name;
}

function calcProgress(milestones) {
  const prod = milestones.filter(m => m.name !== "Legal & Comercial");
  if (!prod.length) return 0;
  return Math.round(prod.reduce((s, m) => s + (m.progress || 0), 0) / prod.length);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching Linear data...");

  // 1. Todos los proyectos — filtramos en JS
  const { projects } = await gql(ALL_PROJECTS_QUERY);
  const expansion = projects.nodes.filter(isExpansionProject);
  console.log(`  Expansion projects found: ${expansion.length}`);

  const countriesFromProjects = [];

  for (const proj of expansion) {
    const country = matchCountry(proj.name);
    if (!country) { console.log(`  Skipping (no country match): ${proj.name}`); continue; }

    const milestones = (proj.projectMilestones?.nodes || []).map(m => ({
      name: milestoneLabel(m.name),
      progress: Math.round(m.progress || 0),
      targetDate: m.targetDate || null,
    }));

    const isCompleted = proj.status.type === "completed" ||
                        proj.status.type === "cancelled";
    const progress    = isCompleted ? 100 : calcProgress(milestones);

    let lastUpdate = "";
    let health     = "onTrack";

    if (proj.status.type === "started") {
      try {
        const upd = await gql(STATUS_UPDATE_QUERY, { projectId: proj.id });
        const latest = upd?.project?.projectUpdates?.nodes?.[0];
        if (latest) {
          lastUpdate = latest.body.replace(/\*\*/g, "").replace(/\n/g, " ").slice(0, 200);
          health     = latest.health || "onTrack";
        }
      } catch (e) {
        console.warn(`  No status update for: ${proj.name}`);
      }
    }

    // Dedupe: keep the most recent non-canceled project per country
    const existing = countriesFromProjects.findIndex(c => c.id === country.id);
    const isCanceled = proj.status.type === "canceled";
    if (existing !== -1) {
      if (!isCanceled) countriesFromProjects.splice(existing, 1); // replace with newer
      else continue;
    }
    if (isCanceled) continue;

    countriesFromProjects.push({
      ...country,
      status:         isCompleted ? "production" : "building",
      progress,
      eta:            proj.targetDate || null,
      completed_date: proj.completedAt ? proj.completedAt.slice(0, 10) : null,
      engineer:       proj.lead?.name || "Por asignar",
      linear_url:     proj.url,
      last_update:    lastUpdate || (isCompleted ? "En producción" : ""),
      health,
      milestones:     milestones.filter(m => m.name !== "Legal & Comercial"),
    });
  }

  // 2. Discovery issues para países sin proyecto
  const { issues } = await gql(DISCOVERY_ISSUES_QUERY);
  const projectIds  = new Set(countriesFromProjects.map(c => c.id));
  const discoveryCountries = [];

  for (const issue of issues.nodes) {
    const country = matchCountry(issue.title);
    if (!country || projectIds.has(country.id)) continue;
    if (discoveryCountries.find(c => c.id === country.id)) continue;

    const isDone = issue.status.type === "completed";
    discoveryCountries.push({
      ...country,
      status:         isDone ? "discovery_done" : "discovery_pending",
      progress:       0,
      eta:            null,
      completed_date: null,
      engineer:       "Wendy Sánchez",
      linear_url:     issue.url,
      last_update:    isDone
        ? `Discovery completado (${issue.identifier}).`
        : `Discovery pendiente (${issue.identifier}). En sprint actual.`,
      health:     "onTrack",
      milestones: [],
    });
  }

  // 3. Países con Discovery manual (Paraguay, Uruguay — sin issue en Linear aún)
  const manualDiscovery = [
    { id: "PY", name: "Paraguay", flag: "🇵🇾",
      status: "discovery_done", progress: 0, eta: null, completed_date: null,
      engineer: "Wendy Sánchez", linear_url: null,
      last_update: "Discovery completado. Sin issue en Linear.", milestones: [] },
    { id: "UY", name: "Uruguay", flag: "🇺🇾",
      status: "discovery_done", progress: 0, eta: null, completed_date: null,
      engineer: "Wendy Sánchez", linear_url: null,
      last_update: "Discovery completado. Sin issue en Linear.", milestones: [] },
  ];
  const allDiscovery = [
    ...discoveryCountries,
    ...manualDiscovery.filter(m => !projectIds.has(m.id) &&
      !discoveryCountries.find(c => c.id === m.id))
  ];

  // 4. Ordenar
  const ORDER = { production: 0, building: 1, discovery_done: 2, discovery_pending: 3 };
  const allCountries = [...countriesFromProjects, ...allDiscovery].sort((a, b) => {
    const d = (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9);
    return d !== 0 ? d : (b.progress || 0) - (a.progress || 0);
  });

  // 5. Feed
  const feed = [];
  for (const c of allCountries) {
    if (c.status === "building" && c.last_update) {
      feed.push({ date: new Date().toISOString().slice(0,10),
        country: c.name, flag: c.flag, text: c.last_update.slice(0,200), health: c.health });
    }
  }
  for (const c of allDiscovery.filter(c => c.status === "discovery_done")) {
    feed.push({ date: new Date().toISOString().slice(0,10),
      country: c.name, flag: c.flag, text: c.last_update, health: "onTrack" });
  }

  const prodCount = allCountries.filter(c => c.status === "production").length;

  // 6. Países sin estudiar
  const not_studied = [
    { id: "HN", name: "Honduras",          flag: "🇭🇳", note: "Sin estudiar" },
    { id: "NI", name: "Nicaragua",         flag: "🇳🇮", note: "Sin estudiar" },
    { id: "PR", name: "Puerto Rico",       flag: "🇵🇷", note: "Sin estudiar" },
    { id: "TT", name: "Trinidad y Tobago", flag: "🇹🇹", note: "Descartado"  },
    { id: "HT", name: "Haití",             flag: "🇭🇹", note: "Descartado"  },
    { id: "JM", name: "Jamaica",           flag: "🇯🇲", note: "Descartado"  },
    { id: "BB", name: "Barbados",          flag: "🇧🇧", note: "Descartado"  },
    { id: "SR", name: "Surinam",           flag: "🇸🇷", note: "Descartado"  },
    { id: "BZ", name: "Belice",            flag: "🇧🇿", note: "Descartado"  },
    { id: "CU", name: "Cuba",              flag: "🇨🇺", note: "Descartado"  },
  ];

  const output = {
    meta: {
      goal: 10,
      deadline: "2026-06-30",
      last_updated: new Date().toISOString().slice(0, 10),
      region: "América Latina",
      production_count: prodCount,
    },
    countries: allCountries,
    not_studied,
    feed: feed.slice(0, 8),
  };

  const outPath = path.join(__dirname, "..", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`✓ data.json actualizado — ${prodCount} en producción, ${allCountries.length} países totales`);
}

main().catch(err => { console.error("FATAL:", err); process.exit(1); });
