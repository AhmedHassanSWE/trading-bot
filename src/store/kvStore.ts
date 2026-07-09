import { Redis } from '@upstash/redis';
import { logger } from '../utils/logger';
import { BotPersistentState, createEmptyState } from './persistentState';

const STATE_KEY = 'bot-state';

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function isKvConfigured(): boolean {
  return getRedis() !== null;
}

export async function loadBotState(): Promise<BotPersistentState> {
  const redis = getRedis();
  if (!redis) {
    logger.warn('Redis not configured — bot state will not persist between runs');
    return createEmptyState();
  }

  const state = await redis.get<BotPersistentState>(STATE_KEY);
  return state ?? createEmptyState();
}

export async function saveBotState(state: BotPersistentState): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.set(STATE_KEY, state);
}
