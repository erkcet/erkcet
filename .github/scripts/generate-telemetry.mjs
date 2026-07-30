import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
const DEFAULT_OUTPUT_PATH = "assets/engineering-telemetry.svg";

function escapeXml(value) {
  // GitHub profile fields are external input, so keep them safe inside the SVG.
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function createDateRange() {
  // GitHub contribution calendars use an inclusive rolling one-year window.
  const to = new Date();
  const from = new Date(to);
  from.setUTCFullYear(from.getUTCFullYear() - 1);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

async function fetchGitHubData(login, token) {
  const { from, to } = createDateRange();
  const query = `
    query EngineeringTelemetry($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        login
        name
        repositories(
          first: 100
          ownerAffiliations: OWNER
          privacy: PUBLIC
          orderBy: { field: UPDATED_AT, direction: DESC }
        ) {
          totalCount
        }
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                contributionCount
              }
            }
          }
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
        }
      }
    }
  `;

  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "erkcet-engineering-telemetry",
    },
    body: JSON.stringify({
      query,
      variables: { login, from, to },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data?.user) {
    throw new Error(`GitHub user "${login}" was not found.`);
  }

  return normalizeGitHubData(payload.data.user);
}

function normalizeGitHubData(user) {
  const collection = user.contributionsCollection;
  // GitHub returns 52 or 53 calendar columns depending on the boundary dates.
  const weeklyTotals = collection.contributionCalendar.weeks.map((week) =>
    week.contributionDays.reduce(
      (total, day) => total + day.contributionCount,
      0,
    ),
  );

  const categorizedContributions =
    collection.totalCommitContributions +
    collection.totalIssueContributions +
    collection.totalPullRequestContributions +
    collection.totalPullRequestReviewContributions;

  const commitShare =
    categorizedContributions > 0
      ? Math.round(
          (collection.totalCommitContributions / categorizedContributions) * 100,
        )
      : 0;

  return {
    login: user.login,
    name: user.name || user.login,
    contributions: collection.contributionCalendar.totalContributions,
    publicRepositories: user.repositories.totalCount,
    activeWeeks: weeklyTotals.filter((value) => value > 0).length,
    commitShare,
    weeklyTotals,
    updatedAt: new Date().toISOString().slice(0, 10),
  };
}

async function loadTelemetryData() {
  const fixturePath = process.env.TELEMETRY_FIXTURE_PATH;
  if (fixturePath) {
    // A fixture makes visual QA deterministic without requiring a local token.
    return JSON.parse(await readFile(fixturePath, "utf8"));
  }

  const login = process.env.GITHUB_LOGIN;
  const token = process.env.GITHUB_TOKEN;

  if (!login || !token) {
    throw new Error(
      "GITHUB_LOGIN and GITHUB_TOKEN are required when no fixture is provided.",
    );
  }

  return fetchGitHubData(login, token);
}

function buildSignalGeometry(weeklyTotals) {
  // Keep the newest 53 weeks so the chart retains a stable visual width.
  const values = weeklyTotals.slice(-53);
  while (values.length < 53) {
    values.unshift(0);
  }

  const left = 42;
  const right = 918;
  const baseline = 309;
  const top = 226;
  const step = (right - left) / (values.length - 1);
  const maxValue = Math.max(...values, 1);

  const points = values.map((value, index) => {
    const x = left + index * step;
    // A square-root scale preserves quieter engineering periods beside spikes.
    const normalized = Math.sqrt(value / maxValue);
    const y = baseline - normalized * (baseline - top);

    return { value, x, y };
  });

  const linePath = points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    })
    .join(" ");

  const bars = points
    .map((point) => {
      const height = Math.max(2, baseline - point.y);
      return `<rect x="${(point.x - 2.5).toFixed(2)}" y="${(
        baseline - height
      ).toFixed(2)}" width="5" height="${height.toFixed(
        2,
      )}" rx="2.5" fill="url(#signalBar)" opacity="${
        point.value > 0 ? "0.72" : "0.12"
      }"/>`;
    })
    .join("");

  const peak = points.reduce(
    (currentPeak, point) =>
      point.value > currentPeak.value ? point : currentPeak,
    points[0],
  );

  return { bars, linePath, peak };
}

function createMetricCard({ x, label, value, accent }) {
  return `
    <g transform="translate(${x} 93)">
      <rect width="205" height="69" rx="12" fill="#10182B" stroke="#243252"/>
      <rect x="0" y="13" width="3" height="43" rx="1.5" fill="${accent}"/>
      <text x="18" y="29" class="metric-label">${escapeXml(label)}</text>
      <text x="18" y="55" class="metric-value">${escapeXml(value)}</text>
    </g>`;
}

function createSvg(data) {
  const signal = buildSignalGeometry(data.weeklyTotals);
  const title = `${data.name} — Engineering Signal`;
  const subtitle = `PUBLIC GITHUB ACTIVITY // ${data.login.toUpperCase()}`;

  const metrics = [
    {
      label: "CONTRIBUTIONS / 12M",
      value: formatNumber(data.contributions),
      accent: "#61DAFB",
    },
    {
      label: "PUBLIC REPOSITORIES",
      value: formatNumber(data.publicRepositories),
      accent: "#8B5CF6",
    },
    {
      label: "ACTIVE WEEKS",
      value: `${data.activeWeeks} / 53`,
      accent: "#22D3EE",
    },
    {
      label: "COMMIT SIGNAL",
      value: `${data.commitShare}%`,
      accent: "#A78BFA",
    },
  ];

  const cards = metrics
    .map((metric, index) =>
      createMetricCard({ ...metric, x: 42 + index * 219 }),
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="350" viewBox="0 0 960 350" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(title)}</title>
  <desc id="desc">A custom engineering telemetry panel showing public GitHub activity over the last year.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#080D18"/>
      <stop offset="0.52" stop-color="#0C1324"/>
      <stop offset="1" stop-color="#11182B"/>
    </linearGradient>
    <linearGradient id="headerAccent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22D3EE"/>
      <stop offset="0.55" stop-color="#60A5FA"/>
      <stop offset="1" stop-color="#A78BFA"/>
    </linearGradient>
    <linearGradient id="signalBar" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#2563EB"/>
      <stop offset="0.55" stop-color="#22D3EE"/>
      <stop offset="1" stop-color="#C084FC"/>
    </linearGradient>
    <filter id="signalGlow" x="-30%" y="-60%" width="160%" height="220%">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <pattern id="microGrid" width="18" height="18" patternUnits="userSpaceOnUse">
      <path d="M18 0H0V18" fill="none" stroke="#314160" stroke-width="0.5" opacity="0.16"/>
    </pattern>
    <style>
      text {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      .eyebrow {
        fill: #7DD3FC;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 2.2px;
      }
      .name {
        fill: #F8FAFC;
        font-size: 25px;
        font-weight: 700;
        letter-spacing: 0.4px;
      }
      .metric-label {
        fill: #7182A6;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1px;
      }
      .metric-value {
        fill: #EAF1FF;
        font-size: 22px;
        font-weight: 700;
      }
      .chart-label {
        fill: #8293B7;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 1.4px;
      }
      .microcopy {
        fill: #607091;
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.7px;
      }
    </style>
  </defs>

  <rect x="0.75" y="0.75" width="958.5" height="348.5" rx="18" fill="url(#background)" stroke="#283755" stroke-width="1.5"/>
  <rect x="1" y="1" width="958" height="348" rx="18" fill="url(#microGrid)" opacity="0.55"/>
  <path d="M0 18Q0 0 18 0H942Q960 0 960 18V22H0Z" fill="url(#headerAccent)" opacity="0.9"/>

  <g transform="translate(42 41)">
    <circle cx="5" cy="5" r="5" fill="#22D3EE" opacity="0.22"/>
    <circle cx="5" cy="5" r="2.4" fill="#67E8F9"/>
    <text x="20" y="9" class="eyebrow">${escapeXml(subtitle)}</text>
    <text x="0" y="41" class="name">${escapeXml(data.name.toUpperCase())}</text>
  </g>

  <g transform="translate(796 42)">
    <rect width="122" height="30" rx="15" fill="#0C2630" stroke="#1B5B66"/>
    <circle cx="18" cy="15" r="4" fill="#34D399"/>
    <circle cx="18" cy="15" r="8" fill="#34D399" opacity="0.1"/>
    <text x="32" y="19" class="eyebrow" style="font-size:9px;letter-spacing:1.2px;fill:#6EE7B7">LIVE SIGNAL</text>
  </g>

  ${cards}

  <g>
    <rect x="42" y="184" width="876" height="139" rx="13" fill="#09111F" stroke="#1E2B47"/>
    <text x="58" y="207" class="chart-label">52-WEEK CONTRIBUTION FREQUENCY</text>
    <text x="902" y="207" text-anchor="end" class="microcopy">PUBLIC ACTIVITY // SQRT SCALE</text>
    <path d="M58 236H902M58 272H902M58 308H902" stroke="#344360" stroke-width="0.7" stroke-dasharray="3 7" opacity="0.48"/>
    ${signal.bars}
    <path d="${signal.linePath}" fill="none" stroke="#6EE7F9" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.84" filter="url(#signalGlow)"/>
    <circle cx="${signal.peak.x.toFixed(2)}" cy="${signal.peak.y.toFixed(2)}" r="4.5" fill="#E879F9" stroke="#F5D0FE" stroke-width="1.4"/>
    <text x="58" y="339" class="microcopy">T−52W</text>
    <text x="902" y="339" text-anchor="end" class="microcopy">NOW // UPDATED ${escapeXml(
      data.updatedAt,
    )}</text>
  </g>

  <path d="M681 55h40l10 10h25M719 55v-9h28l7 7h22" fill="none" stroke="#50658D" stroke-width="1" opacity="0.34"/>
  <circle cx="681" cy="55" r="2" fill="#22D3EE" opacity="0.7"/>
  <circle cx="776" cy="53" r="2" fill="#A78BFA" opacity="0.7"/>
</svg>
`;
}

async function main() {
  const outputPath = process.env.OUTPUT_PATH || DEFAULT_OUTPUT_PATH;
  const data = await loadTelemetryData();
  const svg = createSvg(data);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, svg, "utf8");
  console.log(`Engineering telemetry written to ${outputPath}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
