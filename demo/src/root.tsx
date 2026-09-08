import {Composition} from "remotion";
import {EmbassyDemo} from "./EmbassyDemo";
import {Film} from "./v6/Film";

export const RemotionRoot = () => <>
  <Composition id="EmbassyDemoV6" component={Film} width={1920} height={1080} fps={30} durationInFrames={1200}/>
  <Composition
    id="EmbassyDemo"
    component={EmbassyDemo}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1200}
  />
</>;
