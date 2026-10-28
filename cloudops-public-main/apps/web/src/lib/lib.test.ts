import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { dailyCost, money, moneyFull, shortType } from './format';
import { apiErrorCode, apiErrorMessage } from './api';

describe('format helpers', () => {
  it('strips the provider namespace case-insensitively', () => {
    expect(shortType('Microsoft.Web/sites')).toBe('Web/sites');
    expect(shortType('microsoft.web/sites')).toBe('web/sites');
    expect(shortType('Custom.Type/x')).toBe('Custom.Type/x');
  });

  it('formats compact money in each currency’s own convention (INR in lakh/crore)', () => {
    expect(money(null)).toBe('—');
    expect(money(12.345, 'USD')).toBe('$12.35');
    expect(money(1500, 'INR')).toBe('₹1.5K');
    expect(money(210_120, 'INR')).toBe('₹2.1L');
    expect(money(12_345_678, 'INR')).toBe('₹1.2Cr');
    expect(money(2_500_000, 'USD')).toBe('$2.5M');
    expect(dailyCost(10, 'INR')).toBe('₹10/day');
  });

  it('formats full amounts with Indian digit grouping for INR', () => {
    expect(moneyFull(210_120, 'INR')).toBe('₹2,10,120');
    expect(moneyFull(25.37, 'INR')).toBe('₹25.37');
    expect(moneyFull(210_120, 'USD')).toBe('$210,120');
  });
});

function axiosError(status: number | undefined, data?: unknown): AxiosError {
  const err = new AxiosError('Request failed', status ? 'ERR_BAD_RESPONSE' : 'ERR_NETWORK');
  if (status) {
    err.response = { status, data, statusText: '', headers: {}, config: { headers: new AxiosHeaders() } };
  }
  return err;
}

describe('apiErrorMessage', () => {
  it('uses the server-provided message for client errors', () => {
    expect(apiErrorMessage(axiosError(400, { error: { code: 'validation_error', message: 'Invalid request' } }))).toBe('Invalid request');
    expect(apiErrorCode(axiosError(429, { error: { code: 'rate_limited', message: 'x' } }))).toBe('rate_limited');
  });

  it('explains an unreachable API instead of showing "Network Error"', () => {
    expect(apiErrorMessage(axiosError(undefined))).toMatch(/Can’t reach the CloudOps API/);
  });

  it('appends a support reference to server errors', () => {
    const msg = apiErrorMessage(axiosError(500, { error: { message: 'Something went wrong on our side.', requestId: 'abcdef1234' } }));
    expect(msg).toMatch(/reference abcdef12/);
  });
});
