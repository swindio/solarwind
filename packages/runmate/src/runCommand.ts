import { ChildProcess, exec, ExecOptions } from 'child_process';
import nodePath from 'path';

import chalk from 'chalk';
import { Waterfall, waterfall } from 'plugin-hooks';

import { runmateLogger } from './runmateLogger';

export interface RunCommandOptions {
  command: string;
  plugin?: (hooks: RunCommandHooks) => any;
}

export async function runCommand(
  options: RunCommandOptions | string,
  execOptions?: ExecOptions
): Promise<0> {
  let childRef: ChildProcess | null = null;

  let started = Date.now();

  const hooks: RunCommandHooks | undefined = {
    onStderrData: waterfall(),
    onStdoutData: waterfall(),
    started: waterfall(),
    willStart: waterfall(),
    onClose: waterfall(),
    onError: waterfall(),
  };

  options =
    typeof options === 'string'
      ? {
          command: options,
          plugin(hooks) {
            const c_command_medium = command.replace(/(.{20})(.+)/, `$1…`);
            const description =
              typeof execOptions?.cwd === 'string'
                ? `${c_command_medium} in ./${nodePath.relative(
                    process.cwd(),
                    execOptions.cwd
                  )}`
                : c_command_medium;

            hooks.willStart.register(function data() {
              runmateLogger.log(`\n${chalk.cyan(description)} started\n\n`);
            });

            hooks.onStdoutData.register(function data(currentValue) {
              runmateLogger.log(currentValue.data);
            });

            hooks.onStderrData.register(function data(currentValue) {
              runmateLogger.error(chalk.red(currentValue.data));
            });

            hooks.onClose.register(function data() {
              runmateLogger.log(
                chalk.green(
                  `finished in ${Date.now() - started}ms (${description})\n\n`
                )
              );
            });
          },
        }
      : options;

  let { command, plugin } = options;

  const configFile = await getConfigFile(
    execOptions?.cwd?.toString() || process.cwd()
  );

  const configCommand = configFile?.commands?.[command];

  if (typeof configCommand === 'string') {
    command = configCommand;
  }

  try {
    hooks && (await plugin?.(hooks));

    if (hooks) {
      command = (await hooks?.willStart.exec({ command })).command;
    }

    const child = (childRef = exec(command, { ...execOptions }));

    child.stdout?.on('data', async function (data) {
      await hooks?.onStdoutData.exec({ data }, child);
    });

    child.stderr?.on('data', async function (data) {
      await hooks?.onStderrData.exec({ data }, child);
    });

    return new Promise((resolve, reject) => {
      child.on('close', async (code) => {
        await hooks?.onClose.exec({ code }, child);

        if (code === 0) {
          return resolve(code);
        }

        reject(code);
      });
    });
  } catch (e: any) {
    childRef?.kill(1);
    await hooks.onError.exec({ error: e }, childRef);
    throw new Error(`Failed to execute command ${command}`);
  }
}

async function getConfigFile(
  cwd: string
): Promise<{ commands?: Record<string, string> }> {
  try {
    return require(nodePath.resolve(cwd, '.runmaterc.js'));
  } catch (e) {
    return {};
  }
}

export interface RunCommandHooks {
  willStart: Waterfall<{ command: string }, undefined>;
  started: Waterfall<ChildProcess, { command: string }>;
  onStdoutData: Waterfall<{ data: string }, ChildProcess>;
  onStderrData: Waterfall<{ data: string }, ChildProcess>;
  onClose: Waterfall<{ code: number | null }, ChildProcess>;
  onError: Waterfall<{ error: Error }, ChildProcess | null>;
}