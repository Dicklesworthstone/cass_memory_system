#!/usr/bin/env bun
import { initCommand } from "./commands/init.js";
import { contextCommand } from "./commands/context.js";
import { reflectCommand } from "./commands/reflect.js";
import { markCommand } from "./commands/mark.js";
import { playbookCommand } from "./commands/playbook.js";
import { statsCommand } from "./commands/stats.js";
import { doctorCommand } from "./commands/doctor.js";
import chalk from "chalk";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    process.exit(0);
  }

  if (command === '--version' || command === '-v') {
    console.log('0.1.0');
    process.exit(0);
  }

  try {
    switch (command) {
      case 'init':
        await initCommand({ force: args.includes('--force') });
        break;
        
      case 'context': {
        const taskIndex = args.findIndex(a => !a.startsWith('-') && a !== 'context');
        const task = taskIndex !== -1 ? args[taskIndex] : '';
        const json = args.includes('--json');
        const workspaceIndex = args.indexOf('--workspace');
        const workspace = workspaceIndex !== -1 ? args[workspaceIndex + 1] : undefined;
        
        if (!task) {
          console.error(chalk.red('Error: Task description required'));
          process.exit(1);
        }
        
        await contextCommand(task, { json, workspace });
        break;
      }

      case 'mark': {
        const helpful = args.includes('--helpful');
        const harmful = args.includes('--harmful');
        const sessionIndex = args.indexOf('--session');
        const session = sessionIndex !== -1 ? args[sessionIndex + 1] : undefined;
        const reasonIndex = args.indexOf('--reason');
        const reason = reasonIndex !== -1 ? args[reasonIndex + 1] : undefined;
        const id = args.find(a => !a.startsWith('-') && a !== 'mark');
        
        if (!id) {
          console.error(chalk.red('Error: Bullet ID required'));
          process.exit(1);
        }

        await markCommand(id, { helpful, harmful, session, reason, json: args.includes('--json') });
        break;
      }

      case 'reflect': {
        const daysIndex = args.indexOf('--days');
        const days = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : undefined;
        const dryRun = args.includes('--dry-run');
        await reflectCommand({ days, dryRun, json: args.includes('--json') });
        break;
      }

      case 'playbook': {
        const subcommand = args[1] || 'list';
        const subArgs = args.slice(2);
        const categoryIndex = args.indexOf('--category');
        const category = categoryIndex !== -1 ? args[categoryIndex + 1] : undefined;
        
        await playbookCommand(subcommand, subArgs, { 
          json: args.includes('--json'),
          all: args.includes('--all'),
          category
        });
        break;
      }

      case 'stats':
        await statsCommand({ json: args.includes('--json') });
        break;

      case 'doctor':
      case 'status':
        await doctorCommand({ json: args.includes('--json'), fix: args.includes('--fix') });
        break;

      default:
        console.error(chalk.red(`Unknown command: ${command}`));
        printHelp();
        process.exit(1);
    }
  } catch (err: any) {
    console.error(chalk.red(`Error: ${err.message}`));
    if (process.env.CASS_MEMORY_VERBOSE) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
${chalk.bold('cass-memory (cm)')} v0.1.0
Universal memory system for AI coding agents.

${chalk.bold('COMMANDS')}
  init                    Initialize configuration and playbook
  context <task>          Get relevant context for a task
  mark <rule> <fb>        Record helpful/harmful feedback
  playbook                Manage playbook rules (list, add, remove)
  status                  System health check
  stats                   Playbook statistics
  reflect                 Extract rules from recent sessions

${chalk.bold('OPTIONS')}
  --json                  Output in JSON format
  --workspace <path>      Filter by workspace
  --force                 Force initialization
  --help, -h              Show this help
  --version, -v           Show version
`);
}

main();
