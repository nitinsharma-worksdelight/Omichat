import { loadEnv } from '../config/env';
import { createContainer } from '../container';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from './seed';

const env = loadEnv();
const container = await createContainer(env);
container.startWorkers();
try {
  const result = await seedDemo(container);
  await container.queue.drain();
  console.log(`\n${result.created ? 'Demo organization created' : 'Demo organization already exists'}: Bright Smile Dental`);
  console.log(`  Dashboard login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  if (result.widgetKey) console.log(`  Widget key:      ${result.widgetKey}`);
} finally {
  await container.close();
}
