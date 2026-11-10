import { useLayoutEffect, useRef } from 'preact/hooks';
import type { SolutionRoute } from '../../solutionRoute';
import { mountSolutionRoute } from '../../solutionRouteView';

/** Keep the shared graph mounted when polling or the surrounding reader redraws. */
export function SolutionRouteGraph(props: { model: SolutionRoute; selection?: string; onOpen?: (target: string) => void; onSelect?: (id: string) => void }) {
  const host = useRef<HTMLDivElement>(null), current = useRef(props), controller = useRef<ReturnType<typeof mountSolutionRoute>>();
  const syncing = useRef(false);
  current.current = props;
  useLayoutEffect(() => {
    if (!host.current) return;
    const view = mountSolutionRoute(host.current, current.current.model, {
      onOpen: target => current.current.onOpen?.(target), onSelect: id => { if (!syncing.current) current.current.onSelect?.(id); },
    });
    controller.current = view;
    return () => { view.destroy(); controller.current = undefined; };
  }, [props.model.id]);
  useLayoutEffect(() => { controller.current?.update(props.model); }, [props.model]);
  useLayoutEffect(() => {
    if (props.selection === undefined || !controller.current || host.current?.querySelector<HTMLElement>('[data-solution-heading]')?.dataset.solutionHeading === props.selection) return;
    syncing.current = true;
    try { controller.current.select(props.selection); } finally { syncing.current = false; }
  }, [props.model, props.selection]);
  return <div class="solution-route-host" ref={host} />;
}
