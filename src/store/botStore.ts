import { BotEvent, ClosedTrade } from '../types';

const MAX_TRADES = 50;
const MAX_EVENTS = 100;

export class BotStore {
  private trades: ClosedTrade[] = [];
  private events: BotEvent[] = [];

  addTrade(trade: ClosedTrade): void {
    this.trades.unshift(trade);
    if (this.trades.length > MAX_TRADES) {
      this.trades = this.trades.slice(0, MAX_TRADES);
    }
  }

  getTrades(): ClosedTrade[] {
    return [...this.trades];
  }

  getRealizedPnl(): number {
    return this.trades.reduce((sum, t) => sum + t.pnlUsdt, 0);
  }

  addEvent(level: BotEvent['level'], message: string, data?: Record<string, unknown>): void {
    this.events.unshift({ timestamp: Date.now(), level, message, data });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(0, MAX_EVENTS);
    }
  }

  getEvents(): BotEvent[] {
    return [...this.events];
  }

  importData(trades: ClosedTrade[], events: BotEvent[]): void {
    this.trades = [...trades];
    this.events = [...events];
  }

  exportData(): { trades: ClosedTrade[]; events: BotEvent[] } {
    return { trades: [...this.trades], events: [...this.events] };
  }
}
