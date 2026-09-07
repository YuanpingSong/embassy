import {Composition} from "remotion";
import {EmbassyDemo} from "./EmbassyDemo";

export const RemotionRoot = () => <>
  <Composition
    id="EmbassyDemo"
    component={EmbassyDemo}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1200}
  />
</>;
