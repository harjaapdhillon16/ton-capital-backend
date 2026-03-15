import { getConfig } from '../../config.js';

type NewsItem = {
  title: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  source: string;
  published: string;
};

function sentimentFromTitle(title: string): 'positive' | 'negative' | 'neutral' {
  const lowered = title.toLowerCase();
  if (lowered.includes('hack') || lowered.includes('drop') || lowered.includes('liquidation')) {
    return 'negative';
  }
  if (lowered.includes('surge') || lowered.includes('adoption') || lowered.includes('etf')) {
    return 'positive';
  }
  return 'neutral';
}

async function getCryptoPanicNews(): Promise<NewsItem[]> {
  const key = getConfig().CRYPTOPANIC_API_KEY;
  if (!key) {
    return [];
  }

  const response = await fetch(
    `https://cryptopanic.com/api/v1/posts/?auth_token=${key}&filter=hot&currencies=BTC,ETH,TON`,
    { headers: { Accept: 'application/json' } }
  );

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    results?: Array<{
      title: string;
      source: { title: string };
      published_at: string;
      votes?: { positive?: number; negative?: number };
    }>;
  };

  return (data.results ?? []).slice(0, 10).map((item) => {
    const positive = Number(item.votes?.positive ?? 0);
    const negative = Number(item.votes?.negative ?? 0);
    const sentiment = positive > negative ? 'positive' : negative > positive ? 'negative' : 'neutral';

    return {
      title: item.title,
      source: item.source?.title ?? 'CryptoPanic',
      published: item.published_at,
      sentiment
    };
  });
}

async function getMacroNews(): Promise<NewsItem[]> {
  const key = getConfig().NEWS_API_KEY;
  if (!key) {
    return [];
  }

  const response = await fetch(
    `https://newsapi.org/v2/top-headlines?category=business&pageSize=10&apiKey=${key}`,
    { headers: { Accept: 'application/json' } }
  );

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as {
    articles?: Array<{ title: string; source?: { name?: string }; publishedAt: string }>;
  };

  return (data.articles ?? []).map((item) => ({
    title: item.title,
    source: item.source?.name ?? 'NewsAPI',
    published: item.publishedAt,
    sentiment: sentimentFromTitle(item.title)
  }));
}

export async function getNewsFeed(): Promise<NewsItem[]> {
  const [crypto, macro] = await Promise.all([getCryptoPanicNews(), getMacroNews()]);
  return [...crypto, ...macro].slice(0, 20);
}
