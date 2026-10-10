interface SearchableTestCase {
  id: string;
  name: string;
  zentaoCaseId?: number;
}

export function testCaseDisplayId(testCase: Pick<SearchableTestCase, "id" | "zentaoCaseId">): string {
  return testCase.zentaoCaseId ? `Z-${testCase.zentaoCaseId}` : testCase.id.slice(0, 8).toUpperCase();
}

export function matchesTestCaseSearch(testCase: SearchableTestCase, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [testCase.name, testCase.id, testCaseDisplayId(testCase), testCase.zentaoCaseId ? `#${testCase.zentaoCaseId}` : ""]
    .some((value) => value.toLowerCase().includes(normalized));
}
