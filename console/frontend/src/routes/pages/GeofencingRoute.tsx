import GeoFencingMap from '../../components/GeoFencingMap.jsx';
import { PageFrame } from '../PageFrame';

/* The geo map is the second heaviest page after the topology and is split for
   the same reason. */
export default function GeofencingRoute() {
  return (
    <PageFrame>
      <GeoFencingMap />
    </PageFrame>
  );
}
