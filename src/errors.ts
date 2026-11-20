export class DomainError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

export function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail('NOT_FOUND', '未找到对应记录。');
  return value;
}
