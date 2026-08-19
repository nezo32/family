import { ListTodo } from 'lucide-react';
import { Placeholder } from '@/app/pages/Placeholder';

/**
 * PLACEHOLDER — owned by the `features/tasks` feature agent.
 * Replace the body; keep the file path and the default export.
 */
export default function TasksPage() {
  return (
    <Placeholder
      title="Задачи"
      description="Семейные дела: разовые и повторяющиеся."
      owner="features/tasks"
      icon={ListTodo}
    />
  );
}
