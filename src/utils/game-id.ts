import { faker } from '@faker-js/faker';

/**
 * Generate a human-readable game ID using Faker
 * Format: "adjective-noun-number" (e.g., "brave-tiger-42")
 */
export function generateGameId(): string {
  const adjective = faker.word.adjective();
  const noun = faker.word.noun();
  const num = faker.number.int({ min: 10, max: 99 });
  return `${adjective}-${noun}-${num}`;
}
