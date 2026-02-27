/**
 * Commands — Standalone utility commands
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { safeReadFile, loadConfig, isGitIgnored, execGit, normalizePhaseName, comparePhaseNum, getArchivedPhaseDirs, generateSlugInternal, getMilestoneInfo, resolveModelInternal, MODEL_PROFILES, output, error, findPhaseInternal } = require('./core.cjs');
const { extractFrontmatter } = require('./frontmatter.cjs');

function cmdGenerateSlug(text, raw) {
  if (!text) {
    error('text required for slug generation');
  }

  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const result = { slug };
  output(result, raw, slug);
}

function cmdCurrentTimestamp(format, raw) {
  const now = new Date();
  let result;

  switch (format) {
    case 'date':
      result = now.toISOString().split('T')[0];
      break;
    case 'filename':
      result = now.toISOString().replace(/:/g, '-').replace(/\..+/, '');
      break;
    case 'full':
    default:
      result = now.toISOString();
      break;
  }

  output({ timestamp: result }, raw, result);
}

function cmdListTodos(cwd, area, raw) {
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');

  let count = 0;
  const todos = [];

  try {
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(pendingDir, file), 'utf-8');
        const createdMatch = content.match(/^created:\s*(.+)$/m);
        const titleMatch = content.match(/^title:\s*(.+)$/m);
        const areaMatch = content.match(/^area:\s*(.+)$/m);

        const todoArea = areaMatch ? areaMatch[1].trim() : 'general';

        // Apply area filter if specified
        if (area && todoArea !== area) continue;

        count++;
        todos.push({
          file,
          created: createdMatch ? createdMatch[1].trim() : 'unknown',
          title: titleMatch ? titleMatch[1].trim() : 'Untitled',
          area: todoArea,
          path: path.join('.planning', 'todos', 'pending', file),
        });
      } catch {}
    }
  } catch {}

  const result = { count, todos };
  output(result, raw, count.toString());
}

function cmdVerifyPathExists(cwd, targetPath, raw) {
  if (!targetPath) {
    error('path required for verification');
  }

  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);

  try {
    const stats = fs.statSync(fullPath);
    const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
    const result = { exists: true, type };
    output(result, raw, 'true');
  } catch {
    const result = { exists: false, type: null };
    output(result, raw, 'false');
  }
}

function cmdHistoryDigest(cwd, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const digest = { phases: {}, decisions: [], tech_stack: new Set() };

  // Collect all phase directories: archived + current
  const allPhaseDirs = [];

  // Add archived phases first (oldest milestones first)
  const archived = getArchivedPhaseDirs(cwd);
  for (const a of archived) {
    allPhaseDirs.push({ name: a.name, fullPath: a.fullPath, milestone: a.milestone });
  }

  // Add current phases
  if (fs.existsSync(phasesDir)) {
    try {
      const currentDirs = fs.readdirSync(phasesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      for (const dir of currentDirs) {
        allPhaseDirs.push({ name: dir, fullPath: path.join(phasesDir, dir), milestone: null });
      }
    } catch {}
  }

  if (allPhaseDirs.length === 0) {
    digest.tech_stack = [];
    output(digest, raw);
    return;
  }

  try {
    for (const { name: dir, fullPath: dirPath } of allPhaseDirs) {
      const summaries = fs.readdirSync(dirPath).filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

      for (const summary of summaries) {
        try {
          const content = fs.readFileSync(path.join(dirPath, summary), 'utf-8');
          const fm = extractFrontmatter(content);

          const phaseNum = fm.phase || dir.split('-')[0];

          if (!digest.phases[phaseNum]) {
            digest.phases[phaseNum] = {
              name: fm.name || dir.split('-').slice(1).join(' ') || 'Unknown',
              provides: new Set(),
              affects: new Set(),
              patterns: new Set(),
            };
          }

          // Merge provides
          if (fm['dependency-graph'] && fm['dependency-graph'].provides) {
            fm['dependency-graph'].provides.forEach(p => digest.phases[phaseNum].provides.add(p));
          } else if (fm.provides) {
            fm.provides.forEach(p => digest.phases[phaseNum].provides.add(p));
          }

          // Merge affects
          if (fm['dependency-graph'] && fm['dependency-graph'].affects) {
            fm['dependency-graph'].affects.forEach(a => digest.phases[phaseNum].affects.add(a));
          }

          // Merge patterns
          if (fm['patterns-established']) {
            fm['patterns-established'].forEach(p => digest.phases[phaseNum].patterns.add(p));
          }

          // Merge decisions
          if (fm['key-decisions']) {
            fm['key-decisions'].forEach(d => {
              digest.decisions.push({ phase: phaseNum, decision: d });
            });
          }

          // Merge tech stack
          if (fm['tech-stack'] && fm['tech-stack'].added) {
            fm['tech-stack'].added.forEach(t => digest.tech_stack.add(typeof t === 'string' ? t : t.name));
          }

        } catch (e) {
          // Skip malformed summaries
        }
      }
    }

    // Convert Sets to Arrays for JSON output
    Object.keys(digest.phases).forEach(p => {
      digest.phases[p].provides = [...digest.phases[p].provides];
      digest.phases[p].affects = [...digest.phases[p].affects];
      digest.phases[p].patterns = [...digest.phases[p].patterns];
    });
    digest.tech_stack = [...digest.tech_stack];

    output(digest, raw);
  } catch (e) {
    error('Failed to generate history digest: ' + e.message);
  }
}

function cmdResolveModel(cwd, agentType, raw) {
  if (!agentType) {
    error('agent-type required');
  }

  const config = loadConfig(cwd);
  const profile = config.model_profile || 'balanced';

  const agentModels = MODEL_PROFILES[agentType];
  if (!agentModels) {
    const result = { model: 'sonnet', profile, unknown_agent: true };
    output(result, raw, 'sonnet');
    return;
  }

  const resolved = agentModels[profile] || agentModels['balanced'] || 'sonnet';
  const model = resolved === 'opus' ? 'inherit' : resolved;
  const result = { model, profile };
  output(result, raw, model);
}

function cmdCommit(cwd, message, files, raw, amend) {
  if (!message && !amend) {
    error('commit message required');
  }

  const config = loadConfig(cwd);

  // Check commit_docs config
  if (!config.commit_docs) {
    const result = { committed: false, hash: null, reason: 'skipped_commit_docs_false' };
    output(result, raw, 'skipped');
    return;
  }

  // Check if .planning is gitignored
  if (isGitIgnored(cwd, '.planning')) {
    const result = { committed: false, hash: null, reason: 'skipped_gitignored' };
    output(result, raw, 'skipped');
    return;
  }

  // Stage files
  const filesToStage = files && files.length > 0 ? files : ['.planning/'];
  for (const file of filesToStage) {
    execGit(cwd, ['add', file]);
  }

  // Commit
  const commitArgs = amend ? ['commit', '--amend', '--no-edit'] : ['commit', '-m', message];
  const commitResult = execGit(cwd, commitArgs);
  if (commitResult.exitCode !== 0) {
    if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
      const result = { committed: false, hash: null, reason: 'nothing_to_commit' };
      output(result, raw, 'nothing');
      return;
    }
    const result = { committed: false, hash: null, reason: 'nothing_to_commit', error: commitResult.stderr };
    output(result, raw, 'nothing');
    return;
  }

  // Get short hash
  const hashResult = execGit(cwd, ['rev-parse', '--short', 'HEAD']);
  const hash = hashResult.exitCode === 0 ? hashResult.stdout : null;
  const result = { committed: true, hash, reason: 'committed' };
  output(result, raw, hash || 'committed');
}

function cmdSummaryExtract(cwd, summaryPath, fields, raw) {
  if (!summaryPath) {
    error('summary-path required for summary-extract');
  }

  const fullPath = path.join(cwd, summaryPath);

  if (!fs.existsSync(fullPath)) {
    output({ error: 'File not found', path: summaryPath }, raw);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf-8');
  const fm = extractFrontmatter(content);

  // Parse key-decisions into structured format
  const parseDecisions = (decisionsList) => {
    if (!decisionsList || !Array.isArray(decisionsList)) return [];
    return decisionsList.map(d => {
      const colonIdx = d.indexOf(':');
      if (colonIdx > 0) {
        return {
          summary: d.substring(0, colonIdx).trim(),
          rationale: d.substring(colonIdx + 1).trim(),
        };
      }
      return { summary: d, rationale: null };
    });
  };

  // Build full result
  const fullResult = {
    path: summaryPath,
    one_liner: fm['one-liner'] || null,
    key_files: fm['key-files'] || [],
    tech_added: (fm['tech-stack'] && fm['tech-stack'].added) || [],
    patterns: fm['patterns-established'] || [],
    decisions: parseDecisions(fm['key-decisions']),
    requirements_completed: fm['requirements-completed'] || [],
  };

  // If fields specified, filter to only those fields
  if (fields && fields.length > 0) {
    const filtered = { path: summaryPath };
    for (const field of fields) {
      if (fullResult[field] !== undefined) {
        filtered[field] = fullResult[field];
      }
    }
    output(filtered, raw);
    return;
  }

  output(fullResult, raw);
}

function parseRequirementIds(text) {
  if (!text) return [];
  const matches = text.match(/[A-Z][A-Z0-9]*-\d+/g) || [];
  return [...new Set(matches)];
}

function parseRoadmapGraphData(content) {
  const checklistStatus = new Map();
  const checklistPattern = /-\s*\[([ x])\]\s*\*\*Phase\s+(\d+[A-Z]?(?:\.\d+)*)/gi;
  let checklistMatch;
  while ((checklistMatch = checklistPattern.exec(content)) !== null) {
    checklistStatus.set(checklistMatch[2], checklistMatch[1].toLowerCase() === 'x' ? 'complete' : 'pending');
  }

  const phaseSections = [];
  const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)\n([\s\S]*?)(?=\n#{2,4}\s*Phase\s+\d+[A-Z]?(?:\.\d+)*\s*:|\n##\s+Progress\b|$)/gi;
  let phaseMatch;

  while ((phaseMatch = phasePattern.exec(content)) !== null) {
    const number = phaseMatch[1];
    const name = phaseMatch[2].replace(/\(INSERTED\)/gi, '').trim();
    const section = phaseMatch[3];

    const goalMatch = section.match(/\*\*Goal\*\*:\s*([^\n]+)/i) || section.match(/\*\*Goal:\*\*\s*([^\n]+)/i);
    const dependsMatch = section.match(/\*\*Depends on\*\*:\s*([^\n]+)/i) || section.match(/\*\*Depends on:\*\*\s*([^\n]+)/i);
    const requirementsMatch = section.match(/\*\*Requirements\*\*:\s*([^\n]+)/i) || section.match(/\*\*Requirements:\*\*\s*([^\n]+)/i);
    const successCriteriaMatch = section.match(/\*\*Success Criteria\*\*:\s*\n([\s\S]*?)(?=\n\*\*|\nPlans:|$)/i);

    const dependsOn = [];
    const depRegex = /Phase\s+(\d+[A-Z]?(?:\.\d+)*)/gi;
    let depMatch;
    const dependsText = dependsMatch ? dependsMatch[1] : '';
    while ((depMatch = depRegex.exec(dependsText)) !== null) {
      dependsOn.push(depMatch[1]);
    }

    const plans = [];
    const plansRegex = /-\s*\[([ x])\]\s*([0-9]+(?:\.[0-9]+)?-\d+):\s*([^\n]+)/g;
    let planMatch;
    while ((planMatch = plansRegex.exec(section)) !== null) {
      plans.push({
        id: planMatch[2],
        name: planMatch[3].trim(),
        status: planMatch[1].toLowerCase() === 'x' ? 'complete' : 'pending',
      });
    }

    const success_criteria = [];
    const criteriaBlock = successCriteriaMatch ? successCriteriaMatch[1] : '';
    const criteriaRegex = /(?:^|\n)\s*(?:\d+\.|-)\s+([^\n]+)/g;
    let criteriaMatch;
    while ((criteriaMatch = criteriaRegex.exec(criteriaBlock)) !== null) {
      success_criteria.push(criteriaMatch[1].trim());
    }

    phaseSections.push({
      number,
      name,
      goal: goalMatch ? goalMatch[1].trim() : null,
      success_criteria,
      depends_on: dependsOn,
      requirements: parseRequirementIds(requirementsMatch ? requirementsMatch[1] : ''),
      plans,
      status: checklistStatus.get(number) || 'pending',
    });
  }

  return phaseSections;
}

function firstSentence(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

function ensurePeriod(text) {
  const cleaned = firstSentence(text);
  if (!cleaned) {
    return '';
  }
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function defaultPhaseDescription(phase) {
  const goal = ensurePeriod(phase.goal || `Deliver ${phase.name}`);
  const reqCount = Array.isArray(phase.requirements) ? phase.requirements.length : 0;
  const criteriaCount = Array.isArray(phase.success_criteria) ? phase.success_criteria.length : 0;
  return `${goal} This phase covers ${reqCount} requirement${reqCount === 1 ? '' : 's'} and has ${criteriaCount} success check${criteriaCount === 1 ? '' : 's'} so progress is measurable.`;
}

function phaseContribution(phase) {
  const depCount = Array.isArray(phase.depends_on) ? phase.depends_on.length : 0;
  if (depCount > 0) {
    return `This phase helps the project by building on ${depCount} earlier phase${depCount === 1 ? '' : 's'} and turning that foundation into user-visible progress.`;
  }
  return 'This phase helps the project by creating the base foundation that later phases depend on.';
}

function planDescription(plan, phase) {
  const planName = plan && plan.name ? plan.name : 'unnamed plan work';
  const phaseName = phase && phase.name ? phase.name : 'current phase';
  const phaseGoal = phase && phase.goal ? ensurePeriod(phase.goal) : '';
  return `This plan implements "${planName}" for ${phaseName}. ${phaseGoal}`.trim();
}

function planContribution(phase) {
  const phaseName = phase && phase.name ? phase.name : 'its phase';
  return `This plan helps the project by moving ${phaseName} from design into working implementation that can be tested and shipped.`;
}

function requirementDescription(req) {
  const requirementText = ensurePeriod(req && req.text ? req.text : 'Requirement details were not provided yet.');
  const category = req && req.category ? req.category : 'General';
  return `${requirementText} This requirement is tracked under ${category} so planning and verification stay aligned.`;
}

function requirementContribution(req, mappedPhase) {
  if (mappedPhase) {
    return `This requirement helps the project by defining user value that Phase ${mappedPhase} must deliver before release.`;
  }
  return 'This requirement helps the project by defining expected user value and keeping scope clear.';
}

function makeTicket({ summary, description, projectContribution, acceptanceCriteria, links, notes }) {
  return {
    summary: firstSentence(summary),
    description: firstSentence(description),
    priority: '',
    assignee: '',
    acceptance_criteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria.map(firstSentence).filter(Boolean) : [],
    links: Array.isArray(links) ? links.map(firstSentence).filter(Boolean) : [],
    notes: firstSentence(notes || ''),
    project_contribution: firstSentence(projectContribution),
  };
}

function parseRequirementsGraphData(content) {
  const requirements = new Map();
  const phaseMapping = new Map();

  let currentCategory = null;
  let inV1 = false;
  const lines = content.split('\n');

  for (const line of lines) {
    if (/^##\s+v1 Requirements/i.test(line)) {
      inV1 = true;
      continue;
    }
    if (/^##\s+v2 Requirements/i.test(line) || /^##\s+Out of Scope/i.test(line) || /^##\s+Traceability/i.test(line)) {
      inV1 = false;
    }
    const categoryMatch = line.match(/^###\s+(.+)/);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].trim();
      continue;
    }
    if (!inV1) continue;

    const reqMatch = line.match(/^\s*-\s*(?:\[[ x]\]\s*)?\*\*([A-Z][A-Z0-9]*-\d+)\*\*:\s*(.+)\s*$/);
    if (!reqMatch) continue;

    requirements.set(reqMatch[1], {
      id: reqMatch[1],
      text: reqMatch[2].trim(),
      category: currentCategory,
      status: 'pending',
    });
  }

  const traceabilityRowRegex = /^\|\s*([A-Z][A-Z0-9]*-\d+)\s*\|\s*Phase\s+([0-9]+(?:\.[0-9]+)?)\s*\|\s*([^|]+)\|/i;
  for (const line of lines) {
    const rowMatch = line.match(traceabilityRowRegex);
    if (!rowMatch) continue;
    const reqId = rowMatch[1];
    const phaseNumber = rowMatch[2];
    const status = rowMatch[3].trim().toLowerCase().replace(/\s+/g, '_');

    phaseMapping.set(reqId, phaseNumber);
    if (requirements.has(reqId)) {
      requirements.get(reqId).status = status;
    } else {
      requirements.set(reqId, {
        id: reqId,
        text: null,
        category: null,
        status,
      });
    }
  }

  return { requirements, phaseMapping };
}

function cmdGraphGenerateDev(cwd, raw) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  const projectPath = path.join(cwd, '.planning', 'PROJECT.md');
  const graphPath = path.join(cwd, '.planning', 'DEVELOPMENT_GRAPH.json');

  if (!fs.existsSync(roadmapPath)) {
    output({ generated: false, error: 'ROADMAP.md not found' }, raw, 'no roadmap');
    return;
  }

  const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
  const phases = parseRoadmapGraphData(roadmapContent);

  const requirementsContent = fs.existsSync(requirementsPath)
    ? fs.readFileSync(requirementsPath, 'utf-8')
    : '';
  const { requirements, phaseMapping } = parseRequirementsGraphData(requirementsContent);

  const phaseNodes = [];
  const planNodes = [];
  const requirementNodes = [];
  const edges = [];
  const phaseNodeIds = new Set();
  const planNodeIds = new Set();

  for (const phase of phases) {
    const phaseNodeId = `phase:${phase.number}`;
    phaseNodeIds.add(phaseNodeId);

    const phaseInfo = findPhaseInternal(cwd, phase.number);
    const planFileCount = phaseInfo ? phaseInfo.plans.length : 0;
    const summaryFileCount = phaseInfo ? phaseInfo.summaries.length : 0;

    phaseNodes.push({
      id: phaseNodeId,
      number: phase.number,
      name: phase.name,
      goal: phase.goal,
      success_criteria: phase.success_criteria,
      status: phase.status,
      ticket: makeTicket({
        summary: `Phase ${phase.number}: ${phase.name}`,
        description: defaultPhaseDescription(phase),
        projectContribution: phaseContribution(phase),
        acceptanceCriteria: phase.success_criteria,
      }),
      file_status: {
        plan_files: planFileCount,
        summary_files: summaryFileCount,
      },
    });

    for (const dep of phase.depends_on) {
      edges.push({
        from: phaseNodeId,
        to: `phase:${dep}`,
        type: 'depends_on',
      });
    }

    for (const reqId of phase.requirements) {
      edges.push({
        from: phaseNodeId,
        to: `requirement:${reqId}`,
        type: 'covers_requirement',
      });
      if (!requirements.has(reqId)) {
        requirements.set(reqId, {
          id: reqId,
          text: null,
          category: null,
          status: 'pending',
        });
      }
    }

    for (const plan of phase.plans) {
      const planNodeId = `plan:${plan.id}`;
      if (!planNodeIds.has(planNodeId)) {
        planNodeIds.add(planNodeId);
        planNodes.push({
          id: planNodeId,
          plan_id: plan.id,
          name: plan.name,
          status: plan.status,
          phase: phase.number,
          ticket: makeTicket({
            summary: `${plan.id}: ${plan.name}`,
            description: planDescription(plan, phase),
            projectContribution: planContribution(phase),
            acceptanceCriteria: [
              `Plan ${plan.id} tasks are completed and behavior is verified.`,
              `Results are documented so the team can track delivery.`,
            ],
          }),
        });
      }
      edges.push({
        from: phaseNodeId,
        to: planNodeId,
        type: 'contains_plan',
      });
    }
  }

  for (const req of requirements.values()) {
    requirementNodes.push({
      id: `requirement:${req.id}`,
      req_id: req.id,
      text: req.text,
      category: req.category,
      status: req.status,
      ticket: makeTicket({
        summary: `${req.id}: ${req.text || 'Requirement'}`,
        description: requirementDescription(req),
        projectContribution: requirementContribution(req, phaseMapping.get(req.id)),
        acceptanceCriteria: [
          req.text || `${req.id} behavior is clearly defined and testable.`,
          'Requirement has explicit phase traceability in ROADMAP and REQUIREMENTS.',
        ],
      }),
    });

    const mappedPhase = phaseMapping.get(req.id);
    if (mappedPhase) {
      const from = `phase:${mappedPhase}`;
      const to = `requirement:${req.id}`;
      const alreadyExists = edges.some(e => e.from === from && e.to === to && e.type === 'covers_requirement');
      if (!alreadyExists) {
        edges.push({
          from,
          to,
          type: 'covers_requirement',
        });
      }
    }
  }

  let projectName = null;
  if (fs.existsSync(projectPath)) {
    const projectContent = fs.readFileSync(projectPath, 'utf-8');
    const headingMatch = projectContent.match(/^#\s+(.+)/m);
    projectName = headingMatch ? headingMatch[1].trim() : null;
  }

  fs.mkdirSync(path.dirname(graphPath), { recursive: true });

  const graph = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: {
      name: projectName,
      root: '.planning',
      sources: [
        '.planning/PROJECT.md',
        '.planning/REQUIREMENTS.md',
        '.planning/ROADMAP.md',
        '.planning/phases/',
      ],
    },
    nodes: {
      phases: phaseNodes,
      plans: planNodes,
      requirements: requirementNodes.sort((a, b) => a.req_id.localeCompare(b.req_id)),
      tasks: [],
      commits: [],
    },
    edges,
    stats: {
      phases: phaseNodes.length,
      plans: planNodes.length,
      requirements: requirementNodes.length,
      tasks: 0,
      commits: 0,
      dependency_edges: edges.filter(e => e.type === 'depends_on').length,
      requirement_edges: edges.filter(e => e.type === 'covers_requirement').length,
      containment_edges: edges.filter(e => e.type === 'contains_plan').length,
    },
  };

  fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf-8');

  output({
    generated: true,
    path: '.planning/DEVELOPMENT_GRAPH.json',
    phase_count: graph.stats.phases,
    plan_count: graph.stats.plans,
    requirement_count: graph.stats.requirements,
    edge_count: edges.length,
  }, raw, '.planning/DEVELOPMENT_GRAPH.json');
}

async function cmdWebsearch(query, options, raw) {
  const apiKey = process.env.BRAVE_API_KEY;

  if (!apiKey) {
    // No key = silent skip, agent falls back to built-in WebSearch
    output({ available: false, reason: 'BRAVE_API_KEY not set' }, raw, '');
    return;
  }

  if (!query) {
    output({ available: false, error: 'Query required' }, raw, '');
    return;
  }

  const params = new URLSearchParams({
    q: query,
    count: String(options.limit || 10),
    country: 'us',
    search_lang: 'en',
    text_decorations: 'false'
  });

  if (options.freshness) {
    params.set('freshness', options.freshness);
  }

  try {
    const response = await fetch(
      `https://api.search.brave.com/res/v1/web/search?${params}`,
      {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey
        }
      }
    );

    if (!response.ok) {
      output({ available: false, error: `API error: ${response.status}` }, raw, '');
      return;
    }

    const data = await response.json();

    const results = (data.web?.results || []).map(r => ({
      title: r.title,
      url: r.url,
      description: r.description,
      age: r.age || null
    }));

    output({
      available: true,
      query,
      count: results.length,
      results
    }, raw, results.map(r => `${r.title}\n${r.url}\n${r.description}`).join('\n\n'));
  } catch (err) {
    output({ available: false, error: err.message }, raw, '');
  }
}

function cmdProgressRender(cwd, format, raw) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const milestone = getMilestoneInfo(cwd);

  const phases = [];
  let totalPlans = 0;
  let totalSummaries = 0;

  try {
    const entries = fs.readdirSync(phasesDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => comparePhaseNum(a, b));

    for (const dir of dirs) {
      const dm = dir.match(/^(\d+(?:\.\d+)*)-?(.*)/);
      const phaseNum = dm ? dm[1] : dir;
      const phaseName = dm && dm[2] ? dm[2].replace(/-/g, ' ') : '';
      const phaseFiles = fs.readdirSync(path.join(phasesDir, dir));
      const plans = phaseFiles.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md').length;
      const summaries = phaseFiles.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md').length;

      totalPlans += plans;
      totalSummaries += summaries;

      let status;
      if (plans === 0) status = 'Pending';
      else if (summaries >= plans) status = 'Complete';
      else if (summaries > 0) status = 'In Progress';
      else status = 'Planned';

      phases.push({ number: phaseNum, name: phaseName, plans, summaries, status });
    }
  } catch {}

  const percent = totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0;

  if (format === 'table') {
    // Render markdown table
    const barWidth = 10;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    let out = `# ${milestone.version} ${milestone.name}\n\n`;
    out += `**Progress:** [${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)\n\n`;
    out += `| Phase | Name | Plans | Status |\n`;
    out += `|-------|------|-------|--------|\n`;
    for (const p of phases) {
      out += `| ${p.number} | ${p.name} | ${p.summaries}/${p.plans} | ${p.status} |\n`;
    }
    output({ rendered: out }, raw, out);
  } else if (format === 'bar') {
    const barWidth = 20;
    const filled = Math.round((percent / 100) * barWidth);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);
    const text = `[${bar}] ${totalSummaries}/${totalPlans} plans (${percent}%)`;
    output({ bar: text, percent, completed: totalSummaries, total: totalPlans }, raw, text);
  } else {
    // JSON format
    output({
      milestone_version: milestone.version,
      milestone_name: milestone.name,
      phases,
      total_plans: totalPlans,
      total_summaries: totalSummaries,
      percent,
    }, raw);
  }
}

function cmdTodoComplete(cwd, filename, raw) {
  if (!filename) {
    error('filename required for todo complete');
  }

  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  const completedDir = path.join(cwd, '.planning', 'todos', 'completed');
  const sourcePath = path.join(pendingDir, filename);

  if (!fs.existsSync(sourcePath)) {
    error(`Todo not found: ${filename}`);
  }

  // Ensure completed directory exists
  fs.mkdirSync(completedDir, { recursive: true });

  // Read, add completion timestamp, move
  let content = fs.readFileSync(sourcePath, 'utf-8');
  const today = new Date().toISOString().split('T')[0];
  content = `completed: ${today}\n` + content;

  fs.writeFileSync(path.join(completedDir, filename), content, 'utf-8');
  fs.unlinkSync(sourcePath);

  output({ completed: true, file: filename, date: today }, raw, 'completed');
}

function cmdScaffold(cwd, type, options, raw) {
  const { phase, name } = options;
  const padded = phase ? normalizePhaseName(phase) : '00';
  const today = new Date().toISOString().split('T')[0];

  // Find phase directory
  const phaseInfo = phase ? findPhaseInternal(cwd, phase) : null;
  const phaseDir = phaseInfo ? path.join(cwd, phaseInfo.directory) : null;

  if (phase && !phaseDir && type !== 'phase-dir') {
    error(`Phase ${phase} directory not found`);
  }

  let filePath, content;

  switch (type) {
    case 'context': {
      filePath = path.join(phaseDir, `${padded}-CONTEXT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Context\n\n## Decisions\n\n_Decisions will be captured during /gsd:discuss-phase ${phase}_\n\n## Discretion Areas\n\n_Areas where the executor can use judgment_\n\n## Deferred Ideas\n\n_Ideas to consider later_\n`;
      break;
    }
    case 'uat': {
      filePath = path.join(phaseDir, `${padded}-UAT.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — User Acceptance Testing\n\n## Test Results\n\n| # | Test | Status | Notes |\n|---|------|--------|-------|\n\n## Summary\n\n_Pending UAT_\n`;
      break;
    }
    case 'verification': {
      filePath = path.join(phaseDir, `${padded}-VERIFICATION.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: pending\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Verification\n\n## Goal-Backward Verification\n\n**Phase Goal:** [From ROADMAP.md]\n\n## Checks\n\n| # | Requirement | Status | Evidence |\n|---|------------|--------|----------|\n\n## Result\n\n_Pending verification_\n`;
      break;
    }
    case 'architecture': {
      filePath = path.join(phaseDir, `${padded}-ARCHITECTURE.md`);
      content = `---\nphase: "${padded}"\nname: "${name || phaseInfo?.phase_name || 'Unnamed'}"\ncreated: ${today}\nstatus: draft\n---\n\n# Phase ${phase}: ${name || phaseInfo?.phase_name || 'Unnamed'} — Architecture\n\n## Overview\n\n[Describe the architecture approach for this phase and the boundaries of work.]\n\n## Components\n\n- [Component A] — [Responsibility]\n- [Component B] — [Responsibility]\n\n## Data Flow\n\n\`\`\`mermaid\nflowchart TD\n  User[User Action] --> Entry[Entry Point]\n  Entry --> Service[Core Service]\n  Service --> Storage[(State / Storage)]\n  Service --> Output[Visible Outcome]\n\`\`\`\n\n## Decisions Locked Before Planning\n\n- [Decision 1]\n- [Decision 2]\n\n## Risks / Unknowns\n\n- [Risk]\n- [Unknown]\n\n## Verification Notes\n\n- [How this architecture will be validated during execution]\n`;
      break;
    }
    case 'phase-dir': {
      if (!phase || !name) {
        error('phase and name required for phase-dir scaffold');
      }
      const slug = generateSlugInternal(name);
      const dirName = `${padded}-${slug}`;
      const phasesParent = path.join(cwd, '.planning', 'phases');
      fs.mkdirSync(phasesParent, { recursive: true });
      const dirPath = path.join(phasesParent, dirName);
      fs.mkdirSync(dirPath, { recursive: true });
      output({ created: true, directory: `.planning/phases/${dirName}`, path: dirPath }, raw, dirPath);
      return;
    }
    default:
      error(`Unknown scaffold type: ${type}. Available: context, uat, verification, architecture, phase-dir`);
  }

  if (fs.existsSync(filePath)) {
    output({ created: false, reason: 'already_exists', path: filePath }, raw, 'exists');
    return;
  }

  fs.writeFileSync(filePath, content, 'utf-8');
  const relPath = path.relative(cwd, filePath);
  output({ created: true, path: relPath }, raw, relPath);
}

module.exports = {
  cmdGenerateSlug,
  cmdCurrentTimestamp,
  cmdListTodos,
  cmdVerifyPathExists,
  cmdHistoryDigest,
  cmdResolveModel,
  cmdCommit,
  cmdSummaryExtract,
  cmdGraphGenerateDev,
  cmdWebsearch,
  cmdProgressRender,
  cmdTodoComplete,
  cmdScaffold,
};
