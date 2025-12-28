/**
 * Curated examples for the --examples global flag.
 * Shows common workflows that users can copy-paste.
 */
import chalk from "chalk";
import { getCliName } from "./utils.js";
import { printJsonResult } from "./utils.js";

export interface ExamplesOptions {
  json?: boolean;
}

interface ExampleWorkflow {
  title: string;
  description: string;
  commands: string[];
}

function getWorkflows(): ExampleWorkflow[] {
  const cli = getCliName();
  return [
    {
      title: "Quick Start",
      description: "Essential commands to get started",
      commands: [
        `${cli} init                              # Set up cass-memory`,
        `${cli} context "my task" --json          # Get relevant rules`,
        `${cli} outcome success b-xxx,b-yyy       # Record what helped`,
        `${cli} reflect                           # Learn from session`,
      ],
    },
    {
      title: "Agent Workflow",
      description: "Typical agent session pattern",
      commands: [
        `${cli} context "implement user auth" --json`,
        `# ... do the work ...`,
        `${cli} mark b-abc123 --helpful --reason "saved time"`,
        `${cli} outcome success b-abc123 --session /path/to/session.jsonl`,
      ],
    },
    {
      title: "Playbook Management",
      description: "Add, list, and export rules",
      commands: [
        `${cli} playbook list                     # See all rules`,
        `${cli} playbook list --category testing  # Filter by category`,
        `${cli} playbook add "Always validate input" --category security`,
        `${cli} playbook export --json > backup.json`,
      ],
    },
    {
      title: "System Health",
      description: "Check and maintain the system",
      commands: [
        `${cli} doctor                            # Check health`,
        `${cli} doctor --fix                      # Auto-fix issues`,
        `${cli} stats --json                      # Playbook metrics`,
        `${cli} usage                             # LLM cost tracking`,
      ],
    },
    {
      title: "Learning from History",
      description: "Reflect on past sessions to build knowledge",
      commands: [
        `${cli} reflect --days 7                  # Process recent sessions`,
        `${cli} reflect --dry-run --json          # Preview changes`,
        `${cli} stale --days 90                   # Find unused rules`,
        `${cli} top 10 --json                     # Most effective rules`,
      ],
    },
    {
      title: "Onboarding (Agent-Native)",
      description: "Guided knowledge extraction without API costs",
      commands: [
        `${cli} onboard status                    # Check progress`,
        `${cli} onboard sample --fill-gaps        # Get sessions to analyze`,
        `${cli} onboard read /path/to/session.jsonl --template`,
        `${cli} playbook add "rule" --category debugging`,
      ],
    },
    {
      title: "Safety Guards (Project Hot Stove)",
      description: "Prevent catastrophic mistakes",
      commands: [
        `${cli} guard --install                   # Install safety hooks`,
        `${cli} trauma list                       # View blocked patterns`,
        `${cli} trauma add "^rm -rf /" --severity FATAL`,
        `${cli} audit --trauma --days 30          # Scan for risky patterns`,
      ],
    },
  ];
}

export async function examplesCommand(options: ExamplesOptions = {}): Promise<void> {
  const cli = getCliName();
  const workflows = getWorkflows();

  if (options.json) {
    printJsonResult("examples", {
      workflows: workflows.map((w) => ({
        title: w.title,
        description: w.description,
        commands: w.commands.map((cmd) => cmd.replace(/#.*$/, "").trim()),
      })),
      tip: `Run ${cli} <command> --help for command-specific examples`,
    });
    return;
  }

  // Human-readable output
  console.log(chalk.bold.cyan(`\n${cli} Examples\n`));
  console.log(chalk.gray("Copy-paste these common workflows to get started.\n"));

  for (const workflow of workflows) {
    console.log(chalk.bold.yellow(`${workflow.title}`));
    console.log(chalk.gray(`  ${workflow.description}\n`));
    for (const cmd of workflow.commands) {
      // Split command from comment
      const [command, comment] = cmd.split("#").map((s) => s.trim());
      if (comment) {
        console.log(`  ${chalk.green(command)}  ${chalk.gray(`# ${comment}`)}`);
      } else {
        console.log(`  ${chalk.green(command)}`);
      }
    }
    console.log();
  }

  console.log(chalk.gray(`Tip: ${cli} <command> --help for command-specific examples\n`));
}
