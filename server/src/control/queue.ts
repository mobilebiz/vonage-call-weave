// 制御ジョブの投入先。本番は Cloud Tasks（OIDC 付き HTTP タスク）、ローカルはプロセス内実行。
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { errInfo } from '../log.js';

export interface TaskQueue {
  enqueue(jobId: string, opts?: { delayMs?: number; attempt?: number }): Promise<void>;
}

export class InlineQueue implements TaskQueue {
  private runner: ((jobId: string) => Promise<'done' | 'retry'>) | null = null;

  constructor(
    private readonly log: Logger,
    private readonly maxAttempts = 5,
  ) {}

  bind(runner: (jobId: string) => Promise<'done' | 'retry'>) {
    this.runner = runner;
  }

  async enqueue(jobId: string, opts: { delayMs?: number; attempt?: number } = {}) {
    const attempt = opts.attempt ?? 1;
    setTimeout(async () => {
      if (!this.runner) return;
      try {
        const r = await this.runner(jobId);
        if (r === 'retry' && attempt < this.maxAttempts) {
          await this.enqueue(jobId, { delayMs: Math.min(1000 * 2 ** attempt, 15_000), attempt: attempt + 1 });
        }
      } catch (err) {
        this.log.error('inline job crashed', { jobId, ...errInfo(err) });
      }
    }, opts.delayMs ?? 0);
  }
}

export class CloudTasksQueue implements TaskQueue {
  private clientPromise: Promise<import('@google-cloud/tasks').CloudTasksClient> | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly log: Logger,
  ) {}

  private client() {
    this.clientPromise ??= import('@google-cloud/tasks').then(
      // projectId を明示して、環境の既定プロジェクトを使わない
      (m) => new m.CloudTasksClient({ projectId: this.cfg.gcpProjectId ?? undefined }),
    );
    return this.clientPromise;
  }

  async enqueue(jobId: string, opts: { delayMs?: number; attempt?: number } = {}) {
    const client = await this.client();
    const parent = client.queuePath(this.cfg.gcpProjectId!, this.cfg.tasksLocation, this.cfg.tasksQueue);
    const url = `${this.cfg.controlBaseUrl}/internal/tasks/run`;
    try {
      await client.createTask({
        parent,
        task: {
          // 同名タスクは Cloud Tasks が重複排除する。再投入時は attempt で名前を変える
          name: `${parent}/tasks/${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}-a${opts.attempt ?? 1}`,
          scheduleTime: opts.delayMs ? { seconds: Math.floor((Date.now() + opts.delayMs) / 1000) } : undefined,
          httpRequest: {
            httpMethod: 'POST',
            url,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ jobId })).toString('base64'),
            oidcToken: {
              serviceAccountEmail: this.cfg.tasksInvokerServiceAccount ?? undefined,
              audience: this.cfg.controlBaseUrl,
            },
          },
        },
      });
    } catch (err) {
      // ALREADY_EXISTS は投入済みとして扱う
      if ((err as { code?: number }).code === 6) return;
      this.log.error('cloud tasks enqueue failed', { jobId, ...errInfo(err) });
      throw err;
    }
  }
}
