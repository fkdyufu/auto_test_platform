export interface SequenceCase {
  id: string;
  scenarioId: string;
}

export interface SequenceGroup<T extends SequenceCase> {
  scenarioId: string;
  cases: T[];
}

export function groupCasesByExecutionOrder<T extends SequenceCase>(caseIds: string[], cases: T[]): SequenceGroup<T>[] {
  const caseById = new Map(cases.map((testCase) => [testCase.id, testCase]));
  const groupByScenario = new Map<string, SequenceGroup<T>>();
  const groups: SequenceGroup<T>[] = [];
  for (const caseId of caseIds) {
    const testCase = caseById.get(caseId);
    if (!testCase) continue;
    let group = groupByScenario.get(testCase.scenarioId);
    if (!group) {
      group = { scenarioId: testCase.scenarioId, cases: [] };
      groupByScenario.set(testCase.scenarioId, group);
      groups.push(group);
    }
    group.cases.push(testCase);
  }
  return groups;
}

export function flattenExecutionGroups<T extends SequenceCase>(groups: SequenceGroup<T>[]): string[] {
  return groups.flatMap((group) => group.cases.map((testCase) => testCase.id));
}

export function toggleOrderedCase<T extends SequenceCase>(caseIds: string[], cases: T[], caseId: string): string[] {
  if (caseIds.includes(caseId)) return caseIds.filter((id) => id !== caseId);
  return flattenExecutionGroups(groupCasesByExecutionOrder([...caseIds, caseId], cases));
}

export function moveScenarioGroup<T extends SequenceCase>(caseIds: string[], cases: T[], scenarioId: string, direction: -1 | 1): string[] {
  const groups = groupCasesByExecutionOrder(caseIds, cases);
  const index = groups.findIndex((group) => group.scenarioId === scenarioId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= groups.length) return flattenExecutionGroups(groups);
  [groups[index], groups[nextIndex]] = [groups[nextIndex], groups[index]];
  return flattenExecutionGroups(groups);
}

export function moveCaseWithinScenario<T extends SequenceCase>(caseIds: string[], cases: T[], caseId: string, direction: -1 | 1): string[] {
  const groups = groupCasesByExecutionOrder(caseIds, cases);
  const group = groups.find((item) => item.cases.some((testCase) => testCase.id === caseId));
  if (!group) return flattenExecutionGroups(groups);
  const index = group.cases.findIndex((testCase) => testCase.id === caseId);
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= group.cases.length) return flattenExecutionGroups(groups);
  [group.cases[index], group.cases[nextIndex]] = [group.cases[nextIndex], group.cases[index]];
  return flattenExecutionGroups(groups);
}
