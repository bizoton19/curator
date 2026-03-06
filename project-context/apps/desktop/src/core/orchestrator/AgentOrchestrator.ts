export type AgentTask = {
  id: string;
  description: string;
};

export type AgentResult = {
  taskId: string;
  output: string;
};

export class AgentOrchestrator {
  async runSequential(tasks: AgentTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    for (const task of tasks) {
      results.push({ taskId: task.id, output: "Not implemented" });
    }
    return results;
  }

  async runParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
    return Promise.all(
      tasks.map(async (task) => ({ taskId: task.id, output: "Not implemented" }))
    );
  }
}
