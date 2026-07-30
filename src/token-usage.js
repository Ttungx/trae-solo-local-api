function addTokenUsage(total, usage) {
  if (!usage) return total;
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  return {
    prompt_tokens: (total?.prompt_tokens || 0) + promptTokens,
    completion_tokens: (total?.completion_tokens || 0) + completionTokens,
    total_tokens: (total?.total_tokens || 0) + totalTokens,
  };
}

module.exports = { addTokenUsage };
