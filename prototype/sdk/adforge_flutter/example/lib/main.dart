import 'package:adforge_flutter/adforge_flutter.dart';
import 'package:flutter/material.dart';

Future<void> main() async {
  // One line to connect the app. TrendPilot fills in the address and key when it generates an app.
  await AdForge.init(baseUrl: 'http://localhost:8300', appKey: 'PASTE_THE_KEY_FROM_SDK_SETUP');
  runApp(AdForge.wrap(const MaterialApp(home: Home())));
}

class Home extends StatelessWidget {
  const Home({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Home')),
        body: ListView(children: [
          // A normal image: swapped automatically when its file name is an ad spot.
          Image.asset('assets/images/home_banner.png'),
          // A spot that also counts taps and measures visibility.
          SizedBox(
            height: 160,
            child: AdForgePlacement(spot: 'focus_hero', child: Image.asset('assets/images/focus_hero.png', fit: BoxFit.cover)),
          ),
        ]),
      );
}
