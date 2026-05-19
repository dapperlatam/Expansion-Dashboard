/**
 * fetch-linear.js
 * Regenera data.json jalando la API de Linear.
 * Corre cada lunes via GitHub Action.
 *
 * Requiere: LINEAR_API_KEY en GitHub Secrets / env local.
 * Uso local: LINEAR_API_KEY=xxx node scripts/fetch-linear.js
 */

const fs = require("fs");
const path = require("path");

const LINEAR_API = "https://api.linear.app/graphql";
const API_KEY = process.env.LINEAR_API_KEY;

if (!API_KEY) {
  console.error("ERROR: LINEAR_API_KEY no está definida.");
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

// ── Queries ──────────────────────────────────────────────────────────────────

const EXPANSION_PROJECTS_QUERY = `
  query {
    projects(filter: { initiative: { name: { eq: "Latam Expansion" } } }) {
      nodes {
        id name url
        targetDate startDate
        status { type name }
        lead { name }
        projectMilestones {
          nodes { id name progress targetDate }
        }
      }
    }
  }
`;

const STATUS_UPDATES_QUERY = `
  query StatusUpdates($projectId: String!) {
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
    ) {
      nodes {
        id identifier title url
        status { type name }
        completedAt
        labels { nodes { name } }
      }
    }
  }
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

const COUNTRY_MAP = {
  // Linear project name keywords → country data
  ecuador:      { id: "EC", name: "Ecuador",        flag: "🇪🇨" },
  panama:       { id: "PA", name: "Panamá",          flag: "🇵🇦" },
  "costa rica": { id: "CR", name: "Costa Rica",      flag: "🇨🇷" },
  guatemala:    { id: "GT", name: "Guatemala",       flag: "🇬🇹" },
  mexico:       { id: "MX", name: "México",          flag: "🇲🇽" },
  brazil:       { id: "BR", name: "Brasil",          flag: "🇧🇷" },
  brasil:       { id: "BR", name: "Brasil",          flag: "🇧🇷" },
  argentina:    { id: "AR", name: "Argentina",       flag: "🇦🇷" },
  chile:        { id: "CL", name: "Chile",           flag: "🇨🇱" },
  colombia:     { id: "CO", name: "Colombia",        flag: "🇨🇴" },
  peru:         { id: "PE", name: "Perú",            flag: "🇵🇪" },
  "dominican":  { id: "DO", name: "Rep. Dominicana", flag: "🇩🇴" },
  bolivia:      { id: "BO", name: "Bolivia",         flag: "🇧🇴" },
  venezuela:    { id: "VE", name: "Venezuela",       flag: "🇻🇪" },
  salvador:     { id: "SV", name: "El Salvador",     flag: "🇸🇻" },
  guyana:       { id: "GY", name: "Guyana",          flag: "🇬🇾" },
  honduras:     { id: "HN", name: "Honduras",        flag: "🇭🇳" },
  nicaragua:    { id: "NI", name: "Nicaragua",       flag: "🇳🇮" },
};

function matchCountry(text) {
  const lower = text.toLowerCase();
  for (const [keyword, data] of Object.entries(COUNTRY_MAP)) {
    if (lower.includes(keyword)) return data;
  }
  return null;
}

function statusFromLinear(projectStatus, milestones) {
  if (projectStatus.type === "completed") return "production";
  if (projectStatus.type === "started") {
    // If only Discovery milestone has progress, treat as building/discovery phase
    const nonDisc = milestones.filter(m => !m.name.toLowerCase().includes("discovery"));
    const anyNonDiscProgress = nonDisc.some(m => m.progress > 0);
    return anyNonDiscProgress ? "building" : "building";
  }
  return "planned";
}

function calcOverallProgress(milestones) {
  // Only the 4 production milestones (exclude Legal & Commercial)
  const prod = milestones.filter(
    m => !m.name.toLowerCase().includes("legal") && !m.name.toLowerCase().includes("commercial")
  );
  if (!prod.length) return 0;
  const avg = prod.reduce((sum, m) => sum + (m.progress || 0), 0) / prod.length;
  return Math.round(avg);
}

function milestoneLabel(name) {
  const n = name.toLowerCase();
  if (n.includes("discovery")) return "Discovery";
  if (n.includes("congress") || n.includes("congreso")) return "Congreso";
  if (n.includes("government") || n.includes("gobierno")) return "Gobierno";
  if (n.includes("cross") || n.includes("transvers") || n.includes("service")) return "Transversales";
  if (n.includes("legal") || n.includes("commercial")) return "Legal & Comercial";
  return name;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching Linear data...");

  // 1. Get expansion projects
  const { projects } = await gql(EXPANSION_PROJECTS_QUERY);
  const expansionProjects = projects.nodes;
  console.log(`  Found ${expansionProjects.length} expansion projects`);

  // 2. Get latest status update for each active project
  const countriesFromProjects = [];
  for (const proj of expansionProjects) {
    const country = matchCountry(proj.name);
    if (!country) continue;

    const milestones = (proj.projectMilestones?.nodes || []).map(m => ({
      name: milestoneLabel(m.name),
      progress: Math.round(m.progress || 0),
      targetDate: m.targetDate || null,
    }));

    const prodMilestones = milestones.filter(m => m.name !== "Legal & Comercial");
    const progress = proj.status.type === "completed"
      ? 100
      : calcOverallProgress(prodMilestones);

    let lastUpdate = "";
    let health = "onTrack";

    if (proj.status.type === "started") {
      try {
        const upd = await gql(STATUS_UPDATES_QUERY, { projectId: proj.id });
        const latest = upd?.project?.projectUpdates?.nodes?.[0];
        if (latest) {
          lastUpdate = latest.body.replace(/\*\*/g, "").replace(/\n/g, " ").slice(0, 200);
          health = latest.health || "onTrack";
        }
      } catch (e) {
        console.warn(`  Could not fetch updates for ${proj.name}`);
      }
    }

    countriesFromProjects.push({
      ...country,
      status: proj.status.type === "completed" ? "production" : "building",
      progress,
      eta: proj.targetDate || null,
      completed_date: proj.status.type === "completed"
        ? (proj.projectMilestones?.nodes?.slice(-1)[0]?.targetDate || null)
        : null,
      engineer: proj.lead?.name || "Por asignar",
      linear_url: proj.url,
      last_update: lastUpdate || (proj.status.type === "completed" ? "En producción" : ""),
      health,
      milestones: prodMilestones,
    });
  }

  // 3. Get discovery issues for pipeline countries
  const { issues } = await gql(DISCOVERY_ISSUES_QUERY);
  const discoveryCountries = [];
  const projectIds = new Set(countriesFromProjects.map(c => c.id));

  for (const issue of issues.nodes) {
    const country = matchCountry(issue.title);
    if (!country || projectIds.has(country.id)) continue; // skip if already has a project

    const alreadyAdded = discoveryCountries.find(c => c.id === country.id);
    if (alreadyAdded) continue;

    const isDone = issue.status.type === "completed";
    discoveryCountries.push({
      ...country,
      status: isDone ? "discovery_done" : "discovery_pending",
      progress: 0,
      eta: null,
      completed_date: null,
      engineer: "Wendy Sánchez",
      linear_url: issue.url,
      last_update: isDone
        ? `Discovery completado (${issue.identifier}).`
        : `Discovery pendiente (${issue.identifier}). En sprint actual.`,
      health: "onTrack",
      milestones: [],
    });
  }

  // 4. Build feed from recent status updates (production projects don't have feed entries)
  const feed = [];
  for (const c of countriesFromProjects) {
    if (c.status === "building" && c.last_update) {
      feed.push({
        date: new Date().toISOString().slice(0, 10),
        country: c.name,
        flag: c.flag,
        text: c.last_update.slice(0, 200),
        health: c.health,
      });
    }
  }
  // Add discovery completions
  for (const c of discoveryCountries) {
    if (c.status === "discovery_done") {
      feed.push({
        date: new Date().toISOString().slice(0, 10),
        country: c.name,
        flag: c.flag,
        text: c.last_update,
        health: "onTrack",
      });
    }
  }

  // 5. Sort: production first, then building by progress, then discovery_done, then pending
  const statusOrder = { production: 0, building: 1, discovery_done: 2, discovery_pending: 3, planned: 4 };
  const allCountries = [...countriesFromProjects, ...discoveryCountries].sort((a, b) => {
    const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (so !== 0) return so;
    return (b.progress || 0) - (a.progress || 0);
  });

  const productionCount = allCountries.filter(c => c.status === "production").length;

  const output = {
    meta: {
      goal: 10,
      deadline: "2026-06-30",
      last_updated: new Date().toISOString().slice(0, 10),
      region: "América Latina",
      production_count: productionCount,
    },
    countries: allCountries,
    feed: feed.slice(0, 8),
  };

  const outPath = path.join(__dirname, "..", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");
  console.log(`✓ data.json actualizado — ${productionCount} países en producción, ${allCountries.length} en total`);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
