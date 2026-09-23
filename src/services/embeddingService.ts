export class EmbeddingService {
  /**
   * Generates a 1536-dimensional vector embedding for the given input text
   * using OpenAI's text-embedding-3-small model.
   *
   * Failure handling:
   * - If OPENAI_API_KEY is not configured, returns null (graceful degradation).
   * - If the API call encounters rate limits, timeouts, or network failures,
   *   logs a non-fatal warning and returns null.
   * - Never throws an unhandled error so memory persistence is never blocked.
   */
  static async generateEmbedding(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return null;
    }

    if (!text || typeof text !== 'string') {
      return null;
    }

    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text.normalize('NFKC'),
        }),
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.warn(
          `[EmbeddingService] Warning: API returned HTTP ${response.status}: ${errBody}`
        );
        return null;
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };

      if (data?.data?.[0]?.embedding && Array.isArray(data.data[0].embedding)) {
        return data.data[0].embedding;
      }

      return null;
    } catch (err: any) {
      console.warn(`[EmbeddingService] Warning: Failed to generate embedding: ${err.message}`);
      return null;
    }
  }
}
