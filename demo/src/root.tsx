import {Composition} from "remotion";
import {EmbassyDemo, EmbassyTeaser} from "./EmbassyDemo";

export const RemotionRoot = () => <>
  <Composition
    id="EmbassyDemo"
    component={EmbassyDemo}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1650}
  />
  <Composition
    id="EmbassyTeaser"
    component={EmbassyTeaser}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={360}
  />
</>;
