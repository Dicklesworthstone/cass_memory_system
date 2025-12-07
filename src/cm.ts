#!/usr/bin/env bun
import { initCommand } from "./commands/init.js";
import { contextCommand } from "./commands/context.js";
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
        
        // Simple flag parsing
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

      case 'mark':
      case 'playbook':
      case 'status':
      case 'reflect':
        console.log(chalk.yellow(`Command '${command}' is not yet implemented in this version.`));
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
  mark <rule> <fb>        (Coming soon) Record helpful/harmful feedback
  playbook                (Coming soon) Manage playbook rules
  status                  (Coming soon) System health
  reflect                 (Coming soon) Extract rules from sessions

${chalk.bold('OPTIONS')}
  --json                  Output in JSON format
  --workspace <path>      Filter by workspace
  --force                 Force initialization
  --help, -h              Show this help
  --version, -v           Show version
`);
}

main();