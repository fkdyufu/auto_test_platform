export interface ToolEvidence {
  mark(): void;
  hasEvidence(): boolean;
}

export function createToolEvidence(): ToolEvidence {
  let observed = false;
  return {
    mark: () => {
      observed = true;
    },
    hasEvidence: () => observed,
  };
}
